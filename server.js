const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();
const PORT = 3001;
const SEARCH_FIELDS = new Set(["title", "author", "genre"]);
const SEARCH_RESULT_LIMIT = 8;
const RECOMMENDATION_LIMIT = 5;
const RECOMMENDATION_POOL_LIMIT = 15;
const CHALLENGE_CODE_LENGTH = 6;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "root",
  database: "books",
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function parsePositiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sendServerError(res, context, error) {
  console.error(`${context}:`, error);
  res.status(500).json({ error: "Server error" });
}

function getTrimmedQueryParam(value) {
  return typeof value === "string" ? value.trim() : "";
}

function generateInviteCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < CHALLENGE_CODE_LENGTH; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function createUniqueInviteCode(conn) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const inviteCode = generateInviteCode();
    const [rows] = await conn.execute(
      "SELECT challenge_id FROM reading_challenges WHERE invite_code = ?",
      [inviteCode]
    );

    if (rows.length === 0) {
      return inviteCode;
    }
  }

  throw new Error("Unable to generate a unique invite code");
}

async function ensureDatabaseTables() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS reading_challenges (
      challenge_id INT NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      description VARCHAR(255) DEFAULT NULL,
      invite_code VARCHAR(20) NOT NULL,
      created_by INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge_id),
      UNIQUE KEY invite_code (invite_code),
      CONSTRAINT fk_reading_challenges_user
        FOREIGN KEY (created_by) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS challenge_members (
      challenge_id INT NOT NULL,
      uid INT NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge_id, uid),
      CONSTRAINT fk_challenge_members_challenge
        FOREIGN KEY (challenge_id) REFERENCES reading_challenges(challenge_id) ON DELETE CASCADE,
      CONSTRAINT fk_challenge_members_user
        FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS challenge_books (
      challenge_id INT NOT NULL,
      book_id INT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge_id, book_id),
      CONSTRAINT fk_challenge_books_challenge
        FOREIGN KEY (challenge_id) REFERENCES reading_challenges(challenge_id) ON DELETE CASCADE,
      CONSTRAINT fk_challenge_books_book
        FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

function buildRecommendationReason(matchedGenres, averageRating) {
  const overlapText =
    matchedGenres.length === 1
      ? `Shares the ${matchedGenres[0]} genre with this book`
      : `Shares genres with this book: ${matchedGenres.join(", ")}`;
  return overlapText;
}

function pickRecommendations(candidateRows, limit) {
  const pool = candidateRows
    .slice(0, RECOMMENDATION_POOL_LIMIT)
    .map((row, index) => {
      const normalizedRating = row.average_rating ? Number(row.average_rating) : 0;
      return {
        ...row,
        randomWeight:
          row.overlap_count * 100 +
          normalizedRating * 10 +
          Math.max(RECOMMENDATION_POOL_LIMIT - index, 1),
      };
    });

  const selected = [];

  while (pool.length > 0 && selected.length < limit) {
    const totalWeight = pool.reduce((sum, candidate) => sum + candidate.randomWeight, 0);
    let threshold = Math.random() * totalWeight;
    let chosenIndex = 0;

    for (let i = 0; i < pool.length; i += 1) {
      threshold -= pool[i].randomWeight;
      if (threshold <= 0) {
        chosenIndex = i;
        break;
      }
    }

    const [picked] = pool.splice(chosenIndex, 1);
    selected.push(picked);
  }

  return selected.sort((left, right) => {
    const ratingDiff = (Number(right.average_rating) || 0) - (Number(left.average_rating) || 0);
    if (right.overlap_count !== left.overlap_count) {
      return right.overlap_count - left.overlap_count;
    }
    if (ratingDiff !== 0) {
      return ratingDiff;
    }
    return left.title.localeCompare(right.title) || left.book_id - right.book_id;
  });
}

app.get("/api/search", async (req, res) => {
  try {
    const q = getTrimmedQueryParam(req.query.q);
    const field = getTrimmedQueryParam(req.query.field || "author").toLowerCase();

    if (!q) {
      return res.json([]);
    }

    if (!SEARCH_FIELDS.has(field)) {
      return res.status(400).json({ error: "field must be one of title, author, or genre" });
    }

    const params = [`%${q}%`];
    const searchQueries = {
      title: `
        SELECT book_id, title, author
        FROM books
        WHERE title LIKE ?
        ORDER BY title ASC, author ASC, book_id ASC
        LIMIT ${SEARCH_RESULT_LIMIT}
      `,
      author: `
        SELECT book_id, title, author
        FROM books
        WHERE author LIKE ?
        ORDER BY author ASC, title ASC, book_id ASC
        LIMIT ${SEARCH_RESULT_LIMIT}
      `,
      genre: `
        SELECT DISTINCT b.book_id, b.title, b.author
        FROM books b
        JOIN book_genres bg ON b.hardcover_id = bg.hardcover_id
        JOIN genres g ON bg.genre_id = g.genre_id
        WHERE g.genre_name LIKE ?
        ORDER BY b.title ASC, b.author ASC, b.book_id ASC
        LIMIT ${SEARCH_RESULT_LIMIT}
      `,
    };

    const [rows] = await pool.execute(searchQueries[field], params);
    res.json(rows);
  } catch (error) {
    sendServerError(res, "Search error", error);
  }
});

// ── Book Detail: GET /api/book/:id ──
app.get("/api/book/:id", async (req, res) => {
  try {
    const bookId = req.params.id;

    // Get book info
    const [books] = await pool.execute(
      `SELECT book_id, title, author, isbn, average_rating, description,
              cover_image_url, primary_genre, pages
       FROM books WHERE book_id = ?`,
      [bookId]
    );

    if (books.length === 0) {
      return res.status(404).json({ error: "Book not found" });
    }

    // Get all genres for this book
    const [genres] = await pool.execute(
      `SELECT g.genre_name
       FROM genres g
       JOIN book_genres bg ON g.genre_id = bg.genre_id
       JOIN books b ON b.hardcover_id = bg.hardcover_id
       WHERE b.book_id = ?`,
      [bookId]
    );

    const book = books[0];
    book.genres = genres.map((g) => g.genre_name);

    res.json(book);
  } catch (error) {
    console.error("Book detail error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Rate a Book: POST /api/rate ──
app.post("/api/rate", async (req, res) => {
  try {
    const { uid, book_id, rating } = req.body;

    if (!uid || !book_id || !rating) {
      return res.status(400).json({ error: "uid, book_id, and rating are required" });
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Insert or update the rating
      await conn.execute(
        `INSERT INTO ratings (uid, book_id, rating)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE rating = ?`,
        [uid, book_id, rating, rating]
      );

      // Automatically add to read_books list
      await conn.execute(
        `INSERT IGNORE INTO read_books (uid, book_id) VALUES (?, ?)`,
        [uid, book_id]
      );

      // Remove from want_to_read if it exists (book can't be in both lists)
      await conn.execute(
        `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, book_id]
      );

      await conn.commit();
      res.json({ message: "Rating saved", rating });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Rating error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Get ratings for a book: GET /api/book/:id/ratings ──
app.get("/api/book/:id/ratings", async (req, res) => {
  try {
    const bookId = req.params.id;

    const [rows] = await pool.execute(
      `SELECT AVG(rating) AS avg_rating, COUNT(*) AS num_ratings
       FROM ratings WHERE book_id = ?`,
      [bookId]
    );

    res.json({
      avg_rating: rows[0].avg_rating ? parseFloat(rows[0].avg_rating).toFixed(2) : null,
      num_ratings: rows[0].num_ratings,
    });
  } catch (error) {
    console.error("Get ratings error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Mark a book as read: POST /api/mark-read ──
app.post("/api/mark-read", async (req, res) => {
  try {
    const { uid, book_id } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Add to read_books
      await conn.execute(
        `INSERT IGNORE INTO read_books (uid, book_id) VALUES (?, ?)`,
        [uid, book_id]
      );

      // Remove from want_to_read (can't be in both)
      await conn.execute(
        `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, book_id]
      );

      await conn.commit();
      res.json({ message: "Book marked as read" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Mark read error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Mark a book as want-to-read: POST /api/mark-want-to-read ──
app.post("/api/mark-want-to-read", async (req, res) => {
  try {
    const { uid, book_id } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Add to want_to_read
      await conn.execute(
        `INSERT IGNORE INTO want_to_read (uid, book_id) VALUES (?, ?)`,
        [uid, book_id]
      );

      // Remove from read_books (can't be in both)
      await conn.execute(
        `DELETE FROM read_books WHERE uid = ? AND book_id = ?`,
        [uid, book_id]
      );

      await conn.commit();
      res.json({ message: "Book marked as want-to-read" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Mark want-to-read error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Unmark a book (remove from both lists): POST /api/unmark ──
app.post("/api/unmark", async (req, res) => {
  try {
    const { uid, book_id } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    await pool.execute(
      `DELETE FROM read_books WHERE uid = ? AND book_id = ?`,
      [uid, book_id]
    );
    await pool.execute(
      `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
      [uid, book_id]
    );

    res.json({ message: "Book unmarked" });
  } catch (error) {
    console.error("Unmark error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Get book status for a user: GET /api/book/:id/status?uid= ──
app.get("/api/book/:id/status", async (req, res) => {
  try {
    const bookId = req.params.id;
    const uid = req.query.uid;

    if (!uid) {
      return res.json({ status: null, rating: null });
    }

    const [readRows] = await pool.execute(
      `SELECT 1 FROM read_books WHERE uid = ? AND book_id = ?`,
      [uid, bookId]
    );

    const [wantRows] = await pool.execute(
      `SELECT 1 FROM want_to_read WHERE uid = ? AND book_id = ?`,
      [uid, bookId]
    );

    const [ratingRows] = await pool.execute(
      `SELECT rating FROM ratings WHERE uid = ? AND book_id = ?`,
      [uid, bookId]
    );

    let status = null;
    if (readRows.length > 0) status = "read";
    else if (wantRows.length > 0) status = "want-to-read";

    res.json({
      status,
      rating: ratingRows.length > 0 ? ratingRows[0].rating : null,
    });
  } catch (error) {
    console.error("Book status error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Recommendations: GET /api/recommendations/:id ──
app.get("/api/recommendations/:id", async (req, res) => {
  try {
    const bookId = parsePositiveInt(req.params.id);
    const uid = req.query.uid ? parsePositiveInt(req.query.uid) : null;

    if (!bookId) {
      return res.status(400).json({ error: "book id must be a positive integer" });
    }

    if (req.query.uid && !uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [books] = await pool.execute(
      `SELECT book_id, primary_genre FROM books WHERE book_id = ?`,
      [bookId]
    );

    if (books.length === 0) {
      return res.status(404).json({ error: "Book not found" });
    }

    const [genreRows] = await pool.execute(
      `SELECT DISTINCT g.genre_name
       FROM genres g
       JOIN book_genres bg ON g.genre_id = bg.genre_id
       JOIN books b ON b.hardcover_id = bg.hardcover_id
       WHERE b.book_id = ?
       ORDER BY g.genre_name ASC`,
      [bookId]
    );

    const selectedGenres = genreRows.map((row) => row.genre_name);
    if (selectedGenres.length === 0 && books[0].primary_genre) {
      selectedGenres.push(books[0].primary_genre);
    }

    if (selectedGenres.length === 0) {
      return res.json([]);
    }

    const genrePlaceholders = selectedGenres.map(() => "?").join(", ");
    let sql = `
      SELECT
        b.book_id,
        b.title,
        b.author,
        b.cover_image_url,
        b.average_rating,
        COUNT(DISTINCT g.genre_id) AS overlap_count,
        GROUP_CONCAT(DISTINCT g.genre_name ORDER BY g.genre_name SEPARATOR '||') AS matched_genres
      FROM books b
      JOIN book_genres bg ON b.hardcover_id = bg.hardcover_id
      JOIN genres g ON bg.genre_id = g.genre_id
      WHERE g.genre_name IN (${genrePlaceholders})
        AND b.book_id != ?
    `;
    const params = [...selectedGenres, bookId];

    if (uid) {
      sql += `
        AND NOT EXISTS (
          SELECT 1
          FROM read_books rb
          WHERE rb.uid = ? AND rb.book_id = b.book_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM want_to_read wtr
          WHERE wtr.uid = ? AND wtr.book_id = b.book_id
        )
      `;
      params.push(uid, uid);
    }

    sql += `
      GROUP BY b.book_id, b.title, b.author, b.cover_image_url, b.average_rating
      ORDER BY overlap_count DESC, b.average_rating DESC, b.title ASC, b.book_id ASC
      LIMIT ${RECOMMENDATION_POOL_LIMIT}
    `;

    const [rows] = await pool.execute(sql, params);

    const rankedRows = rows.sort((left, right) => {
      if (right.overlap_count !== left.overlap_count) {
        return right.overlap_count - left.overlap_count;
      }

      const ratingDiff = (Number(right.average_rating) || 0) - (Number(left.average_rating) || 0);
      if (ratingDiff !== 0) {
        return ratingDiff;
      }

      return left.title.localeCompare(right.title) || left.book_id - right.book_id;
    });

    const recommendations = pickRecommendations(rankedRows, RECOMMENDATION_LIMIT).map((row) => {
      const matchedGenres = row.matched_genres ? row.matched_genres.split("||") : [];

      return {
        book_id: row.book_id,
        title: row.title,
        author: row.author,
        cover_image_url: row.cover_image_url,
        average_rating: row.average_rating,
        matched_genres: matchedGenres,
        overlap_count: row.overlap_count,
        reason: buildRecommendationReason(matchedGenres, row.average_rating),
      };
    });

    res.json(recommendations);
  } catch (error) {
    sendServerError(res, "Recommendations error", error);
  }
});

// ── Register: POST /api/register ──
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const [existing] = await pool.execute(
      "SELECT uid FROM users WHERE username = ?",
      [username]
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const [result] = await pool.execute(
      "INSERT INTO users (username, password) VALUES (?, ?)",
      [username, password]
    );

    res.json({ uid: result.insertId, username });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Login: POST /api/login ──
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: "username and password are required" });
    }

    const [rows] = await pool.execute(
      "SELECT uid, username FROM users WHERE username = ? AND password = ?",
      [username, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({ uid: rows[0].uid, username: rows[0].username });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── User Library: GET /api/user/:uid/library ──
app.get("/api/user/:uid/library", async (req, res) => {
  try {
    const uid = req.params.uid;

    const [readRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url
       FROM read_books rb
       JOIN books b ON rb.book_id = b.book_id
       WHERE rb.uid = ?
       ORDER BY b.title ASC`,
      [uid]
    );

    const [wantRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url
       FROM want_to_read wtr
       JOIN books b ON wtr.book_id = b.book_id
       WHERE wtr.uid = ?
       ORDER BY b.title ASC`,
      [uid]
    );

    res.json({ read_books: readRows, want_to_read: wantRows });
  } catch (error) {
    console.error("User library error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── User Ratings: GET /api/user/:uid/ratings ──
app.get("/api/user/:uid/ratings", async (req, res) => {
  try {
    const uid = req.params.uid;

    const [rows] = await pool.execute(
      `SELECT b.book_id, b.title, r.rating
       FROM ratings r
       JOIN books b ON r.book_id = b.book_id
       WHERE r.uid = ?
       ORDER BY b.title ASC`,
      [uid]
    );

    res.json(rows);
  } catch (error) {
    console.error("User ratings error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Create reading challenge from a user's want-to-read list ──
app.post("/api/challenges", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const name = getTrimmedQueryParam(req.body.name);
    const description = getTrimmedQueryParam(req.body.description).slice(0, 255) || null;

    if (!uid) {
      return res.status(400).json({ error: "uid is required" });
    }

    if (!name) {
      return res.status(400).json({ error: "Challenge name is required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [userRows] = await conn.execute("SELECT uid FROM users WHERE uid = ?", [uid]);
      if (userRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const [wantRows] = await conn.execute(
        "SELECT book_id FROM want_to_read WHERE uid = ? ORDER BY book_id ASC",
        [uid]
      );

      if (wantRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          error: "Add at least one book to your Want to Read list before creating a challenge",
        });
      }

      const inviteCode = await createUniqueInviteCode(conn);
      const [result] = await conn.execute(
        `INSERT INTO reading_challenges (name, description, invite_code, created_by)
         VALUES (?, ?, ?, ?)`,
        [name, description, inviteCode, uid]
      );

      const challengeId = result.insertId;

      await conn.execute(
        "INSERT INTO challenge_members (challenge_id, uid) VALUES (?, ?)",
        [challengeId, uid]
      );

      await conn.execute(
        `INSERT INTO challenge_books (challenge_id, book_id)
         SELECT ?, book_id
         FROM want_to_read
         WHERE uid = ?`,
        [challengeId, uid]
      );

      await conn.commit();
      res.status(201).json({
        challenge_id: challengeId,
        invite_code: inviteCode,
        name,
        description,
        book_count: wantRows.length,
      });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    sendServerError(res, "Create challenge error", error);
  }
});

// ── Join a reading challenge by invite code ──
app.post("/api/challenges/join", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const inviteCode = getTrimmedQueryParam(req.body.invite_code).toUpperCase();

    if (!uid || !inviteCode) {
      return res.status(400).json({ error: "uid and invite_code are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [challengeRows] = await conn.execute(
        `SELECT challenge_id, name
         FROM reading_challenges
         WHERE invite_code = ?`,
        [inviteCode]
      );

      if (challengeRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "Challenge not found" });
      }

      const challenge = challengeRows[0];
      const [result] = await conn.execute(
        `INSERT IGNORE INTO challenge_members (challenge_id, uid)
         VALUES (?, ?)`,
        [challenge.challenge_id, uid]
      );

      await conn.commit();
      res.json({
        challenge_id: challenge.challenge_id,
        name: challenge.name,
        joined: result.affectedRows > 0,
      });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  } catch (error) {
    sendServerError(res, "Join challenge error", error);
  }
});

// ── List challenges for a user ──
app.get("/api/challenges/user/:uid", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [rows] = await pool.execute(
      `SELECT
         c.challenge_id,
         c.name,
         c.description,
         c.invite_code,
         c.created_at,
         CASE WHEN c.created_by = ? THEN 1 ELSE 0 END AS is_creator,
         (SELECT COUNT(*) FROM challenge_members cm WHERE cm.challenge_id = c.challenge_id) AS member_count,
         (SELECT COUNT(*) FROM challenge_books cb WHERE cb.challenge_id = c.challenge_id) AS book_count
       FROM reading_challenges c
       JOIN challenge_members cm ON cm.challenge_id = c.challenge_id
       WHERE cm.uid = ?
       ORDER BY c.created_at DESC, c.challenge_id DESC`,
      [uid, uid]
    );

    res.json(rows);
  } catch (error) {
    sendServerError(res, "List challenges error", error);
  }
});

// ── Challenge detail for a member ──
app.get("/api/challenges/:id", async (req, res) => {
  try {
    const challengeId = parsePositiveInt(req.params.id);
    const uid = parsePositiveInt(req.query.uid);

    if (!challengeId || !uid) {
      return res.status(400).json({ error: "challenge id and uid are required" });
    }

    const [membershipRows] = await pool.execute(
      `SELECT 1
       FROM challenge_members
       WHERE challenge_id = ? AND uid = ?`,
      [challengeId, uid]
    );

    if (membershipRows.length === 0) {
      return res.status(403).json({ error: "You must join this challenge before viewing it" });
    }

    const [challengeRows] = await pool.execute(
      `SELECT
         c.challenge_id,
         c.name,
         c.description,
         c.invite_code,
         c.created_at,
         u.username AS creator_name
       FROM reading_challenges c
       JOIN users u ON c.created_by = u.uid
       WHERE c.challenge_id = ?`,
      [challengeId]
    );

    if (challengeRows.length === 0) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const [memberRows] = await pool.execute(
      `SELECT u.uid, u.username
       FROM challenge_members cm
       JOIN users u ON cm.uid = u.uid
       WHERE cm.challenge_id = ?
       ORDER BY u.username ASC`,
      [challengeId]
    );

    const [bookRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url
       FROM challenge_books cb
       JOIN books b ON cb.book_id = b.book_id
       WHERE cb.challenge_id = ?
       ORDER BY b.title ASC`,
      [challengeId]
    );

    res.json({
      challenge: challengeRows[0],
      members: memberRows,
      books: bookRows,
    });
  } catch (error) {
    sendServerError(res, "Challenge detail error", error);
  }
});

ensureDatabaseTables()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database setup error:", error);
    process.exit(1);
  });
