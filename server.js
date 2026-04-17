const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();
const PORT = 3001;
const SEARCH_RESULT_LIMIT = 20;
const RECOMMENDATION_LIMIT = 5;
const RECOMMENDATION_POOL_LIMIT = 15;
const CHALLENGE_CODE_LENGTH = 6;
const DEFAULT_PROFILE_ICON_PATHS = Array.from(
  { length: 6 },
  (_, index) => `/assets/icons/icon${index + 1}.png`,
);

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "root",
  database: "books",
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

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

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getSearchTokens(value) {
  return normalizeForSearch(value).split(" ").filter(Boolean);
}

function getEditDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function isCloseTokenMatch(queryToken, candidateToken) {
  if (queryToken.length <= 2 || candidateToken.length <= 2) {
    return queryToken === candidateToken;
  }

  const allowedDistance =
    queryToken.length <= 4
      ? 1
      : Math.max(2, Math.floor(queryToken.length * 0.3));
  return getEditDistance(queryToken, candidateToken) <= allowedDistance;
}

function fieldMatchesSearchTerm(fieldValue, searchTerm) {
  if (!searchTerm) return true;

  const normalizedFieldValue = normalizeForSearch(fieldValue);
  const normalizedSearchTerm = normalizeForSearch(searchTerm);

  if (!normalizedFieldValue || !normalizedSearchTerm) {
    return false;
  }

  if (normalizedFieldValue.includes(normalizedSearchTerm)) {
    return true;
  }

  const fieldTokens = getSearchTokens(fieldValue);
  const searchTokens = getSearchTokens(searchTerm);

  return searchTokens.every((searchToken) =>
    fieldTokens.some((fieldToken) => isCloseTokenMatch(searchToken, fieldToken)),
  );
}

function getFieldMatchScore(fieldValue, searchTerm) {
  if (!searchTerm) {
    return 0;
  }

  const normalizedFieldValue = normalizeForSearch(fieldValue);
  const normalizedSearchTerm = normalizeForSearch(searchTerm);

  if (!normalizedFieldValue || !normalizedSearchTerm) {
    return 0;
  }

  if (normalizedFieldValue === normalizedSearchTerm) {
    return 120;
  }

  if (normalizedFieldValue.includes(normalizedSearchTerm)) {
    return 100;
  }

  const fieldTokens = getSearchTokens(fieldValue);
  const searchTokens = getSearchTokens(searchTerm);
  const matchingTokens = searchTokens.filter((searchToken) =>
    fieldTokens.some((fieldToken) => isCloseTokenMatch(searchToken, fieldToken)),
  );

  if (matchingTokens.length === searchTokens.length) {
    return 80;
  }

  if (matchingTokens.length > 0) {
    return 35;
  }

  return 0;
}

function buildSearchResultReason(searchTerms, scores) {
  const exactMatches = [];
  const closeMatches = [];

  if (searchTerms.title && scores.title >= 100) exactMatches.push("title");
  if (searchTerms.author && scores.author >= 100) exactMatches.push("author");
  if (searchTerms.genre && scores.genre >= 100) exactMatches.push("genre");

  if (searchTerms.title && scores.title > 0 && scores.title < 100) {
    closeMatches.push("title");
  }
  if (searchTerms.author && scores.author > 0 && scores.author < 100) {
    closeMatches.push("author");
  }
  if (searchTerms.genre && scores.genre > 0 && scores.genre < 100) {
    closeMatches.push("genre");
  }

  if (exactMatches.length > 0 && closeMatches.length === 0) {
    return `Matched ${exactMatches.join(", ")}`;
  }

  if (exactMatches.length > 0) {
    return `Matched ${exactMatches.join(", ")} with a close ${closeMatches.join(", ")} match`;
  }

  if (closeMatches.length > 0) {
    return `Close ${closeMatches.join(", ")} match`;
  }

  return "Recommended from nearby search terms";
}

function countProvidedSearchTerms(searchTerms) {
  return ["title", "author", "genre"].filter((field) => searchTerms[field])
    .length;
}

function getFriendshipPair(leftUid, rightUid) {
  return {
    userOneUid: Math.min(leftUid, rightUid),
    userTwoUid: Math.max(leftUid, rightUid),
  };
}

async function getRankedSearchResults(searchTerms) {
  const [rows] = await pool.execute(
    `
      SELECT
        b.book_id,
        b.title,
        b.author,
        b.average_rating,
        b.cover_image_url,
        b.primary_genre,
        GROUP_CONCAT(DISTINCT g.genre_name ORDER BY g.genre_name SEPARATOR ', ') AS genres
      FROM books b
      LEFT JOIN book_genres bg ON b.hardcover_id = bg.hardcover_id
      LEFT JOIN genres g ON bg.genre_id = g.genre_id
      GROUP BY b.book_id, b.title, b.author, b.average_rating, b.cover_image_url, b.primary_genre
      ORDER BY b.title ASC, b.author ASC, b.book_id ASC
    `,
  );

  const providedTermCount = countProvidedSearchTerms(searchTerms);

  return rows
    .map((row) => {
      const scores = {
        title: getFieldMatchScore(row.title, searchTerms.title),
        author: getFieldMatchScore(row.author, searchTerms.author),
        genre: getFieldMatchScore(row.genres, searchTerms.genre),
      };
      const matchedTermCount = ["title", "author", "genre"].filter(
        (field) => searchTerms[field] && scores[field] > 0,
      ).length;
      const strictMatch =
        fieldMatchesSearchTerm(row.title, searchTerms.title) &&
        fieldMatchesSearchTerm(row.author, searchTerms.author) &&
        fieldMatchesSearchTerm(row.genres, searchTerms.genre);
      const ratingBoost = Number(row.average_rating) || 0;

      return {
        book_id: row.book_id,
        title: row.title,
        author: row.author,
        cover_image_url: row.cover_image_url,
        average_rating: row.average_rating,
        primary_genre: row.primary_genre,
        genres: row.genres,
        match_reason: buildSearchResultReason(searchTerms, scores),
        score:
          scores.title +
          scores.author +
          scores.genre +
          matchedTermCount * 25 +
          (strictMatch ? 200 : 0) +
          ratingBoost,
      };
    })
    .filter((row) => {
      if (providedTermCount === 1) {
        return row.score > 0;
      }

      return row.score >= 60;
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.title.localeCompare(right.title) ||
        left.book_id - right.book_id,
    )
    .slice(0, SEARCH_RESULT_LIMIT)
    .map(({ book_id, title, author, cover_image_url, average_rating, primary_genre, genres, match_reason }) => ({
      book_id,
      title,
      author,
      cover_image_url,
      average_rating,
      primary_genre,
      genres,
      match_reason,
    }));
}

function pickRandomProfileIconPath() {
  return DEFAULT_PROFILE_ICON_PATHS[
    Math.floor(Math.random() * DEFAULT_PROFILE_ICON_PATHS.length)
  ];
}

function isAllowedProfileIconPath(pathname) {
  return DEFAULT_PROFILE_ICON_PATHS.includes(pathname);
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
      [inviteCode],
    );

    if (rows.length === 0) {
      return inviteCode;
    }
  }

  throw new Error("Unable to generate a unique invite code");
}

async function tableColumnExists(tableName, columnName) {
  const [rows] = await pool.execute(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName],
  );

  return rows.length > 0;
}

async function ensureDatabaseSchema() {
  const hasProfileIconColumn = await tableColumnExists(
    "users",
    "profile_icon_url",
  );

  if (!hasProfileIconColumn) {
    await pool.execute(
      "ALTER TABLE users ADD COLUMN profile_icon_url varchar(255) DEFAULT NULL",
    );
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS currently_reading (
      uid INT NOT NULL,
      book_id INT NOT NULL,
      PRIMARY KEY (uid, book_id),
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

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
      FOREIGN KEY (created_by) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS challenge_members (
      challenge_id INT NOT NULL,
      uid INT NOT NULL,
      joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge_id, uid),
      FOREIGN KEY (challenge_id) REFERENCES reading_challenges(challenge_id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS challenge_books (
      challenge_id INT NOT NULL,
      book_id INT NOT NULL,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (challenge_id, book_id),
      FOREIGN KEY (challenge_id) REFERENCES reading_challenges(challenge_id) ON DELETE CASCADE,
      FOREIGN KEY (book_id) REFERENCES books(book_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS reviews (
      review_id INT AUTO_INCREMENT PRIMARY KEY,
      uid INT NOT NULL,
      book_id INT NOT NULL,
      username VARCHAR(255) NOT NULL,
      rating INT NULL,
      review TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_book_review (uid, book_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute("ALTER TABLE reviews MODIFY COLUMN rating INT NULL");

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_follows (
      follower_uid INT NOT NULL,
      followed_uid INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_uid, followed_uid),
      FOREIGN KEY (follower_uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (followed_uid) REFERENCES users(uid) ON DELETE CASCADE,
      CHECK (follower_uid <> followed_uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_one_uid INT NOT NULL,
      user_two_uid INT NOT NULL,
      requested_by_uid INT NOT NULL,
      status ENUM('pending', 'accepted') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_one_uid, user_two_uid),
      FOREIGN KEY (user_one_uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (user_two_uid) REFERENCES users(uid) ON DELETE CASCADE,
      FOREIGN KEY (requested_by_uid) REFERENCES users(uid) ON DELETE CASCADE,
      CHECK (user_one_uid < user_two_uid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS activity_likes (
      review_id INT NOT NULL,
      uid INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (review_id, uid),
      FOREIGN KEY (review_id) REFERENCES reviews(review_id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS activity_comments (
      comment_id INT NOT NULL AUTO_INCREMENT,
      review_id INT NOT NULL,
      uid INT NOT NULL,
      comment TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (comment_id),
      FOREIGN KEY (review_id) REFERENCES reviews(review_id) ON DELETE CASCADE,
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // currently_reading: start_date + current_page
  const hasCRStartDate = await tableColumnExists("currently_reading", "start_date");
  if (!hasCRStartDate) {
    await pool.execute(
      "ALTER TABLE currently_reading ADD COLUMN start_date DATE DEFAULT NULL"
    );
  }
  const hasCRCurrentPage = await tableColumnExists("currently_reading", "current_page");
  if (!hasCRCurrentPage) {
    await pool.execute(
      "ALTER TABLE currently_reading ADD COLUMN current_page INT NOT NULL DEFAULT 0"
    );
  }

  // read_books: finish_date
  const hasRBFinishDate = await tableColumnExists("read_books", "finish_date");
  if (!hasRBFinishDate) {
    await pool.execute(
      "ALTER TABLE read_books ADD COLUMN finish_date DATE DEFAULT NULL"
    );
  }

  // reviews: is_spoiler
  const hasReviewSpoiler = await tableColumnExists("reviews", "is_spoiler");
  if (!hasReviewSpoiler) {
    await pool.execute(
      "ALTER TABLE reviews ADD COLUMN is_spoiler TINYINT(1) NOT NULL DEFAULT 0"
    );
  }

  // reading_goals
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS reading_goals (
      uid INT NOT NULL,
      year SMALLINT NOT NULL,
      goal INT NOT NULL,
      PRIMARY KEY (uid, year),
      FOREIGN KEY (uid) REFERENCES users(uid) ON DELETE CASCADE
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
      const normalizedRating = row.average_rating
        ? Number(row.average_rating)
        : 0;
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
    const totalWeight = pool.reduce(
      (sum, candidate) => sum + candidate.randomWeight,
      0,
    );
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
    const ratingDiff =
      (Number(right.average_rating) || 0) - (Number(left.average_rating) || 0);
    if (right.overlap_count !== left.overlap_count) {
      return right.overlap_count - left.overlap_count;
    }
    if (ratingDiff !== 0) {
      return ratingDiff;
    }
    return (
      left.title.localeCompare(right.title) || left.book_id - right.book_id
    );
  });
}

app.get("/api/search", async (req, res) => {
  try {
    const legacyQuery = getTrimmedQueryParam(req.query.q);
    const legacyField = getTrimmedQueryParam(req.query.field).toLowerCase();
    const searchTerms = {
      title: getTrimmedQueryParam(req.query.title),
      author: getTrimmedQueryParam(req.query.author),
      genre: getTrimmedQueryParam(req.query.genre),
    };

    if (
      legacyQuery &&
      !searchTerms.title &&
      !searchTerms.author &&
      !searchTerms.genre
    ) {
      if (legacyField === "author" || legacyField === "genre") {
        searchTerms[legacyField] = legacyQuery;
      } else {
        searchTerms.title = legacyQuery;
      }
    }

    if (!searchTerms.title && !searchTerms.author && !searchTerms.genre) {
      return res.json([]);
    }

    res.json(await getRankedSearchResults(searchTerms));
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
      [bookId],
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
      [bookId],
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
      return res
        .status(400)
        .json({ error: "uid, book_id, and rating are required" });
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
        [uid, book_id, rating, rating],
      );

      // Automatically add to read_books list
      await conn.execute(
        `INSERT IGNORE INTO read_books (uid, book_id) VALUES (?, ?)`,
        [uid, book_id],
      );

      // Keep shelf status mutually exclusive.
      await conn.execute(
        `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
      );

      await conn.execute(
        `DELETE FROM currently_reading WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
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
      [bookId],
    );

    res.json({
      avg_rating: rows[0].avg_rating
        ? parseFloat(rows[0].avg_rating).toFixed(2)
        : null,
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
    const { uid, book_id, finish_date } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const resolvedFinishDate = finish_date || today;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Add to read_books with finish_date
      await conn.execute(
        `INSERT INTO read_books (uid, book_id, finish_date)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE finish_date = COALESCE(finish_date, ?)`,
        [uid, book_id, resolvedFinishDate, resolvedFinishDate],
      );

      // Keep shelf status mutually exclusive.
      await conn.execute(
        `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
      );

      await conn.execute(
        `DELETE FROM currently_reading WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
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
        [uid, book_id],
      );

      // Keep shelf status mutually exclusive.
      await conn.execute(
        `DELETE FROM read_books WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
      );

      await conn.execute(
        `DELETE FROM currently_reading WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
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

// ── Mark a book as currently reading: POST /api/mark-currently-reading ──
app.post("/api/mark-currently-reading", async (req, res) => {
  try {
    const { uid, book_id, start_date } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const resolvedStartDate = start_date || today;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.execute(
        `INSERT INTO currently_reading (uid, book_id, start_date, current_page)
         VALUES (?, ?, ?, 0)
         ON DUPLICATE KEY UPDATE start_date = COALESCE(start_date, ?)`,
        [uid, book_id, resolvedStartDate, resolvedStartDate],
      );

      await conn.execute(
        `DELETE FROM read_books WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
      );

      await conn.execute(
        `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, book_id],
      );

      await conn.commit();
      res.json({ message: "Book marked as currently reading" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Mark currently reading error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Unmark a book (remove from all shelves): POST /api/unmark ──
app.post("/api/unmark", async (req, res) => {
  try {
    const { uid, book_id } = req.body;

    if (!uid || !book_id) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    await pool.execute(
      `DELETE FROM read_books WHERE uid = ? AND book_id = ?`,
      [uid, book_id],
    );
    await pool.execute(
      `DELETE FROM want_to_read WHERE uid = ? AND book_id = ?`,
      [uid, book_id],
    );
    await pool.execute(
      `DELETE FROM currently_reading WHERE uid = ? AND book_id = ?`,
      [uid, book_id],
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
      `SELECT finish_date FROM read_books WHERE uid = ? AND book_id = ?`,
      [uid, bookId],
    );

    const [wantRows] = await pool.execute(
      `SELECT 1 FROM want_to_read WHERE uid = ? AND book_id = ?`,
      [uid, bookId],
    );

    const [currentRows] = await pool.execute(
      `SELECT current_page, start_date FROM currently_reading WHERE uid = ? AND book_id = ?`,
      [uid, bookId],
    );

    const [ratingRows] = await pool.execute(
      `SELECT rating FROM ratings WHERE uid = ? AND book_id = ?`,
      [uid, bookId],
    );

    let status = null;
    if (readRows.length > 0) status = "read";
    else if (currentRows.length > 0) status = "currently-reading";
    else if (wantRows.length > 0) status = "want-to-read";

    res.json({
      status,
      rating: ratingRows.length > 0 ? ratingRows[0].rating : null,
      current_page: currentRows.length > 0 ? currentRows[0].current_page : null,
      start_date: currentRows.length > 0 ? currentRows[0].start_date : null,
      finish_date: readRows.length > 0 ? readRows[0].finish_date : null,
    });
  } catch (error) {
    console.error("Book status error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Get reviews for a book: GET /api/book/:id/reviews ──
app.get("/api/book/:id/reviews", async (req, res) => {
  try {
    const bookId = parsePositiveInt(req.params.id);
    const viewerUid = req.query.uid ? parsePositiveInt(req.query.uid) : null;

    if (!bookId) {
      return res
        .status(400)
        .json({ error: "book id must be a positive integer" });
    }

    const [rows] = await pool.execute(
      `SELECT
         r.review_id,
         r.uid,
         COALESCE(u.username, r.username) AS username,
         COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url,
         r.rating,
         r.review,
         r.is_spoiler,
         r.created_at,
         COUNT(DISTINCT al.uid) AS like_count,
         COUNT(DISTINCT ac.comment_id) AS comment_count,
         MAX(CASE WHEN my_like.uid IS NULL THEN 0 ELSE 1 END) AS liked_by_me
       FROM reviews r
       LEFT JOIN users u ON r.uid = u.uid
       LEFT JOIN activity_likes al ON r.review_id = al.review_id
       LEFT JOIN activity_likes my_like
         ON r.review_id = my_like.review_id AND my_like.uid = ?
       LEFT JOIN activity_comments ac ON r.review_id = ac.review_id
       WHERE r.book_id = ?
       GROUP BY
         r.review_id,
         r.uid,
         u.username,
         u.profile_icon_url,
         r.username,
         r.rating,
         r.review,
         r.is_spoiler,
         r.created_at
       ORDER BY r.created_at DESC`,
      [viewerUid || 0, bookId],
    );

    if (rows.length === 0) {
      return res.json([]);
    }

    const reviewIds = rows.map((row) => row.review_id);
    const placeholders = reviewIds.map(() => "?").join(", ");
    const [comments] = await pool.execute(
      `SELECT
         ac.comment_id,
         ac.review_id,
         ac.uid,
         ac.comment,
         ac.created_at,
         u.username,
         COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM activity_comments ac
       JOIN users u ON ac.uid = u.uid
       WHERE ac.review_id IN (${placeholders})
       ORDER BY ac.created_at ASC, ac.comment_id ASC`,
      reviewIds,
    );

    const commentsByReviewId = comments.reduce((groups, comment) => {
      if (!groups[comment.review_id]) groups[comment.review_id] = [];
      groups[comment.review_id].push(comment);
      return groups;
    }, {});

    res.json(
      rows.map((row) => ({
        ...row,
        liked_by_me: Boolean(row.liked_by_me),
        comments: commentsByReviewId[row.review_id] || [],
      })),
    );
  } catch (error) {
    console.error("Get reviews error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Create or update a review: POST /api/review ──
app.post("/api/review", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const bookId = parsePositiveInt(req.body.book_id);
    const hasRating =
      req.body.rating !== undefined &&
      req.body.rating !== null &&
      String(req.body.rating).trim() !== "";
    const rating = hasRating ? Number.parseInt(req.body.rating, 10) : null;
    const username = getTrimmedQueryParam(req.body.username);
    const review = getTrimmedQueryParam(req.body.review);
    const isSpoiler = req.body.is_spoiler ? 1 : 0;

    if (!uid || !bookId || !username || !review) {
      return res.status(400).json({
        error: "uid, book_id, username, and review are required",
      });
    }

    if (hasRating && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Make sure the user exists
      const [userRows] = await conn.execute(
        `SELECT uid FROM users WHERE uid = ?`,
        [uid],
      );

      if (userRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      // Make sure the book exists
      const [bookRows] = await conn.execute(
        `SELECT book_id FROM books WHERE book_id = ?`,
        [bookId],
      );

      if (bookRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "Book not found" });
      }

      const [libraryRows] = await conn.execute(
        `SELECT 1 FROM read_books WHERE uid = ? AND book_id = ?
         UNION
         SELECT 1 FROM currently_reading WHERE uid = ? AND book_id = ?
         UNION
         SELECT 1 FROM want_to_read WHERE uid = ? AND book_id = ?`,
        [uid, bookId, uid, bookId, uid, bookId],
      );

      if (libraryRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          error:
            "Add this book to Read, Currently Reading, or Want to Read before reviewing it",
        });
      }

      // Save/update the review without changing the user's reading-list status.
      await conn.execute(
        `INSERT INTO reviews (uid, book_id, username, rating, review, is_spoiler)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           username = VALUES(username),
           rating = VALUES(rating),
           review = VALUES(review),
           is_spoiler = VALUES(is_spoiler)`,
        [uid, bookId, username, rating, review, isSpoiler],
      );

      if (hasRating) {
        await conn.execute(
          `INSERT INTO ratings (uid, book_id, rating)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE rating = VALUES(rating)`,
          [uid, bookId, rating],
        );
      }

      await conn.commit();
      res.json({ message: "Activity saved successfully" });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  } catch (error) {
    console.error("Review save error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Recommendations: GET /api/recommendations/:id ──
app.get("/api/recommendations/:id", async (req, res) => {
  try {
    const bookId = parsePositiveInt(req.params.id);
    const uid = req.query.uid ? parsePositiveInt(req.query.uid) : null;

    if (!bookId) {
      return res
        .status(400)
        .json({ error: "book id must be a positive integer" });
    }

    if (req.query.uid && !uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [books] = await pool.execute(
      `SELECT book_id, primary_genre FROM books WHERE book_id = ?`,
      [bookId],
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
      [bookId],
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

      const ratingDiff =
        (Number(right.average_rating) || 0) -
        (Number(left.average_rating) || 0);
      if (ratingDiff !== 0) {
        return ratingDiff;
      }

      return (
        left.title.localeCompare(right.title) || left.book_id - right.book_id
      );
    });

    const recommendations = pickRecommendations(
      rankedRows,
      RECOMMENDATION_LIMIT,
    ).map((row) => {
      const matchedGenres = row.matched_genres
        ? row.matched_genres.split("||")
        : [];

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
      return res
        .status(400)
        .json({ error: "username and password are required" });
    }

    if (password.length < 8) {
      return res
        .status(400)
        .json({ error: "Password must be at least 8 characters long" });
    }

    if (!/[A-Z]/.test(password)) {
      return res
        .status(400)
        .json({ error: "Password must contain at least one uppercase letter" });
    }

    if (!/\d/.test(password)) {
      return res
        .status(400)
        .json({ error: "Password must contain at least one number" });
    }

    const [existing] = await pool.execute(
      "SELECT uid FROM users WHERE username = ?",
      [username],
    );

    if (existing.length > 0) {
      return res.status(409).json({ error: "Username already exists" });
    }

    const profileIconUrl = pickRandomProfileIconPath();

    const [result] = await pool.execute(
      "INSERT INTO users (username, password, profile_icon_url) VALUES (?, ?, ?)",
      [username, password, profileIconUrl],
    );

    res.json({ uid: result.insertId, username, profile_icon_url: profileIconUrl });
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
      return res
        .status(400)
        .json({ error: "username and password are required" });
    }

    const [rows] = await pool.execute(
      "SELECT uid, username, profile_icon_url FROM users WHERE username = ? AND password = ?",
      [username, password],
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({
      uid: rows[0].uid,
      username: rows[0].username,
      profile_icon_url: rows[0].profile_icon_url || DEFAULT_PROFILE_ICON_PATHS[0],
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Available default profile icons: GET /api/profile-icons ──
app.get("/api/profile-icons", (req, res) => {
  res.json(DEFAULT_PROFILE_ICON_PATHS);
});

// ── Get public user profile: GET /api/user/:uid ──
app.get("/api/user/:uid", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);
    const viewerUid = req.query.viewer_uid
      ? parsePositiveInt(req.query.viewer_uid)
      : null;

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [rows] = await pool.execute(
      `SELECT uid, username, COALESCE(profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM users
       WHERE uid = ?`,
      [uid],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const profile = rows[0];

    if (viewerUid && viewerUid !== uid) {
      const [followRows] = await pool.execute(
        `SELECT 1 FROM user_follows WHERE follower_uid = ? AND followed_uid = ?`,
        [viewerUid, uid],
      );
      const { userOneUid, userTwoUid } = getFriendshipPair(viewerUid, uid);
      const [friendRows] = await pool.execute(
        `SELECT status, requested_by_uid
         FROM friendships
         WHERE user_one_uid = ? AND user_two_uid = ?`,
        [userOneUid, userTwoUid],
      );

      profile.is_following = followRows.length > 0;
      profile.friendship_status = friendRows[0]?.status || null;
      profile.requested_by_uid = friendRows[0]?.requested_by_uid || null;
    }

    res.json(profile);
  } catch (error) {
    sendServerError(res, "Get user profile error", error);
  }
});

// ── Get user profile icon: GET /api/user/:uid/profile-icon ──
app.get("/api/user/:uid/profile-icon", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [rows] = await pool.execute(
      "SELECT profile_icon_url FROM users WHERE uid = ?",
      [uid],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      uid,
      profile_icon_url: rows[0].profile_icon_url || DEFAULT_PROFILE_ICON_PATHS[0],
    });
  } catch (error) {
    sendServerError(res, "Get profile icon error", error);
  }
});

// ── Update user profile icon: PATCH /api/user/:uid/profile-icon ──
app.patch("/api/user/:uid/profile-icon", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);
    const profileIconUrl = getTrimmedQueryParam(req.body.profile_icon_url);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    if (!isAllowedProfileIconPath(profileIconUrl)) {
      return res.status(400).json({
        error: "profile_icon_url must be one of the default icon paths",
      });
    }

    const [result] = await pool.execute(
      "UPDATE users SET profile_icon_url = ? WHERE uid = ?",
      [profileIconUrl, uid],
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ uid, profile_icon_url: profileIconUrl });
  } catch (error) {
    sendServerError(res, "Update profile icon error", error);
  }
});

// ── User search for social features: GET /api/users/search?q=&uid= ──
app.get("/api/users/search", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.query.uid);
    const q = getTrimmedQueryParam(req.query.q);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    if (!q) {
      return res.json([]);
    }

    const [rows] = await pool.execute(
      `SELECT
         u.uid,
         u.username,
         COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url,
         CASE WHEN uf.follower_uid IS NULL THEN 0 ELSE 1 END AS is_following,
         f.status AS friendship_status,
         f.requested_by_uid
       FROM users u
       LEFT JOIN user_follows uf
         ON uf.follower_uid = ? AND uf.followed_uid = u.uid
       LEFT JOIN friendships f
         ON f.user_one_uid = LEAST(?, u.uid)
        AND f.user_two_uid = GREATEST(?, u.uid)
       WHERE u.uid != ?
         AND u.username LIKE ?
       ORDER BY u.username ASC
       LIMIT 20`,
      [uid, uid, uid, uid, `%${q}%`],
    );

    res.json(rows);
  } catch (error) {
    sendServerError(res, "User search error", error);
  }
});

// ── Follow a user: POST /api/follow ──
app.post("/api/follow", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const targetUid = parsePositiveInt(req.body.target_uid);

    if (!uid || !targetUid || uid === targetUid) {
      return res.status(400).json({ error: "valid uid and target_uid are required" });
    }

    await pool.execute(
      `INSERT IGNORE INTO user_follows (follower_uid, followed_uid)
       VALUES (?, ?)`,
      [uid, targetUid],
    );

    res.json({ message: "User followed" });
  } catch (error) {
    sendServerError(res, "Follow error", error);
  }
});

// ── Unfollow a user: POST /api/unfollow ──
app.post("/api/unfollow", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const targetUid = parsePositiveInt(req.body.target_uid);

    if (!uid || !targetUid || uid === targetUid) {
      return res.status(400).json({ error: "valid uid and target_uid are required" });
    }

    await pool.execute(
      `DELETE FROM user_follows WHERE follower_uid = ? AND followed_uid = ?`,
      [uid, targetUid],
    );

    res.json({ message: "User unfollowed" });
  } catch (error) {
    sendServerError(res, "Unfollow error", error);
  }
});

// ── Request or accept a friend: POST /api/friend-request ──
app.post("/api/friend-request", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const targetUid = parsePositiveInt(req.body.target_uid);

    if (!uid || !targetUid || uid === targetUid) {
      return res.status(400).json({ error: "valid uid and target_uid are required" });
    }

    const { userOneUid, userTwoUid } = getFriendshipPair(uid, targetUid);
    const [existing] = await pool.execute(
      `SELECT requested_by_uid, status
       FROM friendships
       WHERE user_one_uid = ? AND user_two_uid = ?`,
      [userOneUid, userTwoUid],
    );

    if (existing.length > 0) {
      if (existing[0].status === "accepted") {
        return res.json({ message: "Already friends", status: "accepted" });
      }

      if (existing[0].requested_by_uid !== uid) {
        await pool.execute(
          `UPDATE friendships
           SET status = 'accepted'
           WHERE user_one_uid = ? AND user_two_uid = ?`,
          [userOneUid, userTwoUid],
        );
        return res.json({ message: "Friend request accepted", status: "accepted" });
      }

      return res.json({ message: "Friend request already sent", status: "pending" });
    }

    await pool.execute(
      `INSERT INTO friendships (user_one_uid, user_two_uid, requested_by_uid, status)
       VALUES (?, ?, ?, 'pending')`,
      [userOneUid, userTwoUid, uid],
    );

    res.json({ message: "Friend request sent", status: "pending" });
  } catch (error) {
    sendServerError(res, "Friend request error", error);
  }
});

// ── Respond to a friend request: POST /api/friend-request/respond ──
app.post("/api/friend-request/respond", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const requesterUid = parsePositiveInt(req.body.requester_uid);
    const action = getTrimmedQueryParam(req.body.action);

    if (!uid || !requesterUid || uid === requesterUid) {
      return res.status(400).json({ error: "valid uid and requester_uid are required" });
    }

    if (action !== "accept" && action !== "decline") {
      return res.status(400).json({ error: "action must be accept or decline" });
    }

    const { userOneUid, userTwoUid } = getFriendshipPair(uid, requesterUid);

    if (action === "accept") {
      const [result] = await pool.execute(
        `UPDATE friendships
         SET status = 'accepted'
         WHERE user_one_uid = ?
           AND user_two_uid = ?
           AND requested_by_uid = ?
           AND status = 'pending'`,
        [userOneUid, userTwoUid, requesterUid],
      );

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: "Friend request not found" });
      }

      return res.json({ message: "Friend request accepted" });
    }

    await pool.execute(
      `DELETE FROM friendships
       WHERE user_one_uid = ?
         AND user_two_uid = ?
         AND requested_by_uid = ?
         AND status = 'pending'`,
      [userOneUid, userTwoUid, requesterUid],
    );

    res.json({ message: "Friend request declined" });
  } catch (error) {
    sendServerError(res, "Friend response error", error);
  }
});

// ── Social summary: GET /api/user/:uid/social ──
app.get("/api/user/:uid/social", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [friends] = await pool.execute(
      `SELECT u.uid, u.username, COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM friendships f
       JOIN users u
         ON u.uid = CASE WHEN f.user_one_uid = ? THEN f.user_two_uid ELSE f.user_one_uid END
       WHERE (f.user_one_uid = ? OR f.user_two_uid = ?)
         AND f.status = 'accepted'
       ORDER BY u.username ASC`,
      [uid, uid, uid],
    );

    const [pendingRequests] = await pool.execute(
      `SELECT u.uid, u.username, COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM friendships f
       JOIN users u ON u.uid = f.requested_by_uid
       WHERE (f.user_one_uid = ? OR f.user_two_uid = ?)
         AND f.requested_by_uid != ?
         AND f.status = 'pending'
       ORDER BY f.created_at DESC`,
      [uid, uid, uid],
    );

    const [following] = await pool.execute(
      `SELECT u.uid, u.username, COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM user_follows uf
       JOIN users u ON uf.followed_uid = u.uid
       WHERE uf.follower_uid = ?
       ORDER BY u.username ASC`,
      [uid],
    );

    res.json({ friends, pending_requests: pendingRequests, following });
  } catch (error) {
    sendServerError(res, "Social summary error", error);
  }
});

// ── User Library: GET /api/user/:uid/library ──
app.get("/api/user/:uid/library", async (req, res) => {
  try {
    const uid = req.params.uid;

    const [readRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url, rb.finish_date
       FROM read_books rb
       JOIN books b ON rb.book_id = b.book_id
       WHERE rb.uid = ?
       ORDER BY b.title ASC`,
      [uid],
    );

    const [wantRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url
       FROM want_to_read wtr
       JOIN books b ON wtr.book_id = b.book_id
       WHERE wtr.uid = ?
       ORDER BY b.title ASC`,
      [uid],
    );

    const [currentRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url, b.pages,
              cr.current_page, cr.start_date
       FROM currently_reading cr
       JOIN books b ON cr.book_id = b.book_id
       WHERE cr.uid = ?
       ORDER BY b.title ASC`,
      [uid],
    );

    res.json({
      read_books: readRows,
      currently_reading: currentRows,
      want_to_read: wantRows,
    });
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
      [uid],
    );

    res.json(rows);
  } catch (error) {
    console.error("User ratings error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// ── Activity feed: GET /api/activity?uid= ──
app.get("/api/activity", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.query.uid);
    const targetUid = req.query.target_uid
      ? parsePositiveInt(req.query.target_uid)
      : null;

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    if (req.query.target_uid && !targetUid) {
      return res
        .status(400)
        .json({ error: "target_uid must be a positive integer" });
    }

    const visibilityClause = targetUid
      ? "r.uid = ?"
      : `(
          r.uid = ?
          OR EXISTS (
            SELECT 1 FROM user_follows uf
            WHERE uf.follower_uid = ? AND uf.followed_uid = r.uid
          )
          OR EXISTS (
            SELECT 1 FROM friendships f
            WHERE f.status = 'accepted'
              AND (
                (f.user_one_uid = ? AND f.user_two_uid = r.uid)
                OR (f.user_two_uid = ? AND f.user_one_uid = r.uid)
              )
          )
        )`;
    const visibilityParams = targetUid
      ? [targetUid]
      : [uid, uid, uid, uid];

    const [activities] = await pool.execute(
      `SELECT
         r.review_id,
         r.uid,
         COALESCE(u.username, r.username) AS username,
         COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url,
         r.book_id,
         r.rating,
         r.review,
         r.created_at,
         r.updated_at,
         b.title,
         b.author,
         b.cover_image_url,
         COUNT(DISTINCT al.uid) AS like_count,
         COUNT(DISTINCT ac.comment_id) AS comment_count,
         MAX(CASE WHEN my_like.uid IS NULL THEN 0 ELSE 1 END) AS liked_by_me
       FROM reviews r
       JOIN users u ON r.uid = u.uid
       JOIN books b ON r.book_id = b.book_id
       LEFT JOIN activity_likes al ON r.review_id = al.review_id
       LEFT JOIN activity_likes my_like
         ON r.review_id = my_like.review_id AND my_like.uid = ?
       LEFT JOIN activity_comments ac ON r.review_id = ac.review_id
       WHERE ${visibilityClause}
       GROUP BY
         r.review_id,
         r.uid,
         u.username,
         u.profile_icon_url,
         r.username,
         r.book_id,
         r.rating,
         r.review,
         r.created_at,
         r.updated_at,
         b.title,
         b.author,
         b.cover_image_url
       ORDER BY r.updated_at DESC, r.review_id DESC
       LIMIT 50`,
      [uid, ...visibilityParams],
    );

    if (activities.length === 0) {
      return res.json([]);
    }

    const reviewIds = activities.map((activity) => activity.review_id);
    const placeholders = reviewIds.map(() => "?").join(", ");
    const [comments] = await pool.execute(
      `SELECT
         ac.comment_id,
         ac.review_id,
         ac.uid,
         ac.comment,
         ac.created_at,
         u.username,
         COALESCE(u.profile_icon_url, '/assets/icons/icon1.png') AS profile_icon_url
       FROM activity_comments ac
       JOIN users u ON ac.uid = u.uid
       WHERE ac.review_id IN (${placeholders})
       ORDER BY ac.created_at ASC, ac.comment_id ASC`,
      reviewIds,
    );

    const commentsByReviewId = comments.reduce((groups, comment) => {
      if (!groups[comment.review_id]) groups[comment.review_id] = [];
      groups[comment.review_id].push(comment);
      return groups;
    }, {});

    res.json(
      activities.map((activity) => ({
        ...activity,
        liked_by_me: Boolean(activity.liked_by_me),
        comments: commentsByReviewId[activity.review_id] || [],
      })),
    );
  } catch (error) {
    sendServerError(res, "Activity feed error", error);
  }
});

// ── Like an activity: POST /api/activity/:reviewId/like ──
app.post("/api/activity/:reviewId/like", async (req, res) => {
  try {
    const reviewId = parsePositiveInt(req.params.reviewId);
    const uid = parsePositiveInt(req.body.uid);

    if (!reviewId || !uid) {
      return res.status(400).json({ error: "review id and uid are required" });
    }

    await pool.execute(
      `INSERT IGNORE INTO activity_likes (review_id, uid) VALUES (?, ?)`,
      [reviewId, uid],
    );

    res.json({ message: "Activity liked" });
  } catch (error) {
    sendServerError(res, "Activity like error", error);
  }
});

// ── Unlike an activity: POST /api/activity/:reviewId/unlike ──
app.post("/api/activity/:reviewId/unlike", async (req, res) => {
  try {
    const reviewId = parsePositiveInt(req.params.reviewId);
    const uid = parsePositiveInt(req.body.uid);

    if (!reviewId || !uid) {
      return res.status(400).json({ error: "review id and uid are required" });
    }

    await pool.execute(
      `DELETE FROM activity_likes WHERE review_id = ? AND uid = ?`,
      [reviewId, uid],
    );

    res.json({ message: "Activity unliked" });
  } catch (error) {
    sendServerError(res, "Activity unlike error", error);
  }
});

// ── Comment on an activity: POST /api/activity/:reviewId/comments ──
app.post("/api/activity/:reviewId/comments", async (req, res) => {
  try {
    const reviewId = parsePositiveInt(req.params.reviewId);
    const uid = parsePositiveInt(req.body.uid);
    const comment = getTrimmedQueryParam(req.body.comment);

    if (!reviewId || !uid || !comment) {
      return res
        .status(400)
        .json({ error: "review id, uid, and comment are required" });
    }

    await pool.execute(
      `INSERT INTO activity_comments (review_id, uid, comment)
       VALUES (?, ?, ?)`,
      [reviewId, uid, comment],
    );

    res.status(201).json({ message: "Comment added" });
  } catch (error) {
    sendServerError(res, "Activity comment error", error);
  }
});

// ── User Reviews: GET /api/user/:uid/reviews ──
app.get("/api/user/:uid/reviews", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);

    if (!uid) {
      return res.status(400).json({ error: "uid must be a positive integer" });
    }

    const [rows] = await pool.execute(
      `SELECT
         r.review_id,
         r.book_id,
         r.rating,
         r.review,
         r.is_spoiler,
         r.created_at,
         r.updated_at,
         b.title,
         b.author,
         b.cover_image_url
       FROM reviews r
       JOIN books b ON r.book_id = b.book_id
       WHERE r.uid = ?
       ORDER BY r.updated_at DESC, b.title ASC`,
      [uid],
    );

    res.json(rows);
  } catch (error) {
    sendServerError(res, "User reviews error", error);
  }
});

// ── Create reading challenge from a user's want-to-read list ──
app.post("/api/challenges", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const name = getTrimmedQueryParam(req.body.name);
    const description =
      getTrimmedQueryParam(req.body.description).slice(0, 255) || null;

    if (!uid) {
      return res.status(400).json({ error: "uid is required" });
    }

    if (!name) {
      return res.status(400).json({ error: "Challenge name is required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [userRows] = await conn.execute(
        "SELECT uid FROM users WHERE uid = ?",
        [uid],
      );
      if (userRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "User not found" });
      }

      const [wantRows] = await conn.execute(
        "SELECT book_id FROM want_to_read WHERE uid = ? ORDER BY book_id ASC",
        [uid],
      );

      if (wantRows.length === 0) {
        await conn.rollback();
        return res.status(400).json({
          error:
            "Add at least one book to your Want to Read list before creating a challenge",
        });
      }

      const inviteCode = await createUniqueInviteCode(conn);
      const [result] = await conn.execute(
        `INSERT INTO reading_challenges (name, description, invite_code, created_by)
         VALUES (?, ?, ?, ?)`,
        [name, description, inviteCode, uid],
      );

      const challengeId = result.insertId;

      await conn.execute(
        "INSERT INTO challenge_members (challenge_id, uid) VALUES (?, ?)",
        [challengeId, uid],
      );

      await conn.execute(
        `INSERT INTO challenge_books (challenge_id, book_id)
         SELECT ?, book_id
         FROM want_to_read
         WHERE uid = ?`,
        [challengeId, uid],
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
      return res
        .status(400)
        .json({ error: "uid and invite_code are required" });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [challengeRows] = await conn.execute(
        `SELECT challenge_id, name
         FROM reading_challenges
         WHERE invite_code = ?`,
        [inviteCode],
      );

      if (challengeRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: "Challenge not found" });
      }

      const challenge = challengeRows[0];
      const [result] = await conn.execute(
        `INSERT IGNORE INTO challenge_members (challenge_id, uid)
         VALUES (?, ?)`,
        [challenge.challenge_id, uid],
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
         u.username AS creator_name,
         u.profile_icon_url AS creator_profile_icon_url,
         CASE WHEN c.created_by = ? THEN 1 ELSE 0 END AS is_creator,
         (SELECT COUNT(*) FROM challenge_members cm WHERE cm.challenge_id = c.challenge_id) AS member_count,
         (SELECT COUNT(*) FROM challenge_books cb WHERE cb.challenge_id = c.challenge_id) AS book_count
       FROM reading_challenges c
       JOIN challenge_members cm ON cm.challenge_id = c.challenge_id
       JOIN users u ON c.created_by = u.uid
       WHERE cm.uid = ?
       ORDER BY c.created_at DESC, c.challenge_id DESC`,
      [uid, uid],
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
      return res
        .status(400)
        .json({ error: "challenge id and uid are required" });
    }

    const [membershipRows] = await pool.execute(
      `SELECT 1
       FROM challenge_members
       WHERE challenge_id = ? AND uid = ?`,
      [challengeId, uid],
    );

    if (membershipRows.length === 0) {
      return res
        .status(403)
        .json({ error: "You must join this challenge before viewing it" });
    }

    const [challengeRows] = await pool.execute(
      `SELECT
         c.challenge_id,
         c.name,
         c.description,
         c.invite_code,
         c.created_at,
         u.username AS creator_name,
         u.profile_icon_url AS creator_profile_icon_url
       FROM reading_challenges c
       JOIN users u ON c.created_by = u.uid
       WHERE c.challenge_id = ?`,
      [challengeId],
    );

    if (challengeRows.length === 0) {
      return res.status(404).json({ error: "Challenge not found" });
    }

    const [memberRows] = await pool.execute(
      `SELECT u.uid, u.username, u.profile_icon_url
       FROM challenge_members cm
       JOIN users u ON cm.uid = u.uid
       WHERE cm.challenge_id = ?
       ORDER BY u.username ASC`,
      [challengeId],
    );

    const [bookRows] = await pool.execute(
      `SELECT b.book_id, b.title, b.author, b.cover_image_url
       FROM challenge_books cb
       JOIN books b ON cb.book_id = b.book_id
       WHERE cb.challenge_id = ?
       ORDER BY b.title ASC`,
      [challengeId],
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

// ── Reading stats: GET /api/user/:uid/stats ──
app.get("/api/user/:uid/stats", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);
    if (!uid) return res.status(400).json({ error: "uid must be a positive integer" });

    const [[counts]] = await pool.execute(
      `SELECT
         (SELECT COUNT(*) FROM read_books WHERE uid = ?) AS total_read,
         (SELECT COUNT(*) FROM currently_reading WHERE uid = ?) AS total_currently_reading,
         (SELECT COUNT(*) FROM want_to_read WHERE uid = ?) AS total_want_to_read,
         (SELECT COUNT(*) FROM reviews WHERE uid = ?) AS total_reviews,
         (SELECT ROUND(AVG(rating), 2) FROM ratings WHERE uid = ?) AS avg_rating_given,
         (SELECT COUNT(*) FROM read_books WHERE uid = ? AND YEAR(finish_date) = YEAR(CURDATE())) AS books_finished_this_year`,
      [uid, uid, uid, uid, uid, uid],
    );

    const [genreRows] = await pool.execute(
      `SELECT b.primary_genre, COUNT(*) AS cnt
       FROM read_books rb
       JOIN books b ON rb.book_id = b.book_id
       WHERE rb.uid = ? AND b.primary_genre IS NOT NULL
       GROUP BY b.primary_genre
       ORDER BY cnt DESC
       LIMIT 1`,
      [uid],
    );

    res.json({
      ...counts,
      favorite_genre: genreRows.length > 0 ? genreRows[0].primary_genre : null,
    });
  } catch (error) {
    sendServerError(res, "Stats error", error);
  }
});

// ── Annual reading goal: GET /api/user/:uid/goal ──
app.get("/api/user/:uid/goal", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);
    if (!uid) return res.status(400).json({ error: "uid must be a positive integer" });

    const year = new Date().getFullYear();
    const [rows] = await pool.execute(
      `SELECT goal FROM reading_goals WHERE uid = ? AND year = ?`,
      [uid, year],
    );

    res.json({ year, goal: rows.length > 0 ? rows[0].goal : null });
  } catch (error) {
    sendServerError(res, "Get goal error", error);
  }
});

// ── Set annual reading goal: POST /api/user/:uid/goal ──
app.post("/api/user/:uid/goal", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.params.uid);
    const goal = parsePositiveInt(req.body.goal);

    if (!uid) return res.status(400).json({ error: "uid must be a positive integer" });
    if (!goal) return res.status(400).json({ error: "goal must be a positive integer" });

    const year = new Date().getFullYear();
    await pool.execute(
      `INSERT INTO reading_goals (uid, year, goal) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE goal = ?`,
      [uid, year, goal, goal],
    );

    res.json({ year, goal });
  } catch (error) {
    sendServerError(res, "Set goal error", error);
  }
});

// ── Update reading progress: PATCH /api/reading-progress ──
app.patch("/api/reading-progress", async (req, res) => {
  try {
    const uid = parsePositiveInt(req.body.uid);
    const bookId = parsePositiveInt(req.body.book_id);
    const currentPage = req.body.current_page !== undefined ? Number.parseInt(req.body.current_page, 10) : null;
    const startDate = req.body.start_date ? getTrimmedQueryParam(req.body.start_date) : undefined;

    if (!uid || !bookId) {
      return res.status(400).json({ error: "uid and book_id are required" });
    }

    const [existing] = await pool.execute(
      `SELECT 1 FROM currently_reading WHERE uid = ? AND book_id = ?`,
      [uid, bookId],
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Book is not on your currently reading shelf" });
    }

    const updates = [];
    const params = [];

    if (currentPage !== null && !Number.isNaN(currentPage) && currentPage >= 0) {
      updates.push("current_page = ?");
      params.push(currentPage);
    }
    if (startDate !== undefined) {
      updates.push("start_date = ?");
      params.push(startDate || null);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No valid fields to update" });
    }

    params.push(uid, bookId);
    await pool.execute(
      `UPDATE currently_reading SET ${updates.join(", ")} WHERE uid = ? AND book_id = ?`,
      params,
    );

    res.json({ message: "Reading progress updated" });
  } catch (error) {
    sendServerError(res, "Reading progress error", error);
  }
});

// ── Edit a review: PUT /api/review/:id ──
app.put("/api/review/:id", async (req, res) => {
  try {
    const reviewId = parsePositiveInt(req.params.id);
    const uid = parsePositiveInt(req.body.uid);
    const review = getTrimmedQueryParam(req.body.review);
    const hasRating =
      req.body.rating !== undefined &&
      req.body.rating !== null &&
      String(req.body.rating).trim() !== "";
    const rating = hasRating ? Number.parseInt(req.body.rating, 10) : null;
    const isSpoiler = req.body.is_spoiler ? 1 : 0;

    if (!reviewId || !uid) {
      return res.status(400).json({ error: "review id and uid are required" });
    }
    if (!review) {
      return res.status(400).json({ error: "review text is required" });
    }
    if (hasRating && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    const [rows] = await pool.execute(
      `SELECT uid FROM reviews WHERE review_id = ?`,
      [reviewId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Review not found" });
    }
    if (rows[0].uid !== uid) {
      return res.status(403).json({ error: "You can only edit your own reviews" });
    }

    await pool.execute(
      `UPDATE reviews SET review = ?, rating = ?, is_spoiler = ? WHERE review_id = ?`,
      [review, hasRating ? rating : null, isSpoiler, reviewId],
    );

    if (hasRating) {
      const [bookRows] = await pool.execute(
        `SELECT book_id FROM reviews WHERE review_id = ?`,
        [reviewId],
      );
      if (bookRows.length > 0) {
        await pool.execute(
          `INSERT INTO ratings (uid, book_id, rating) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE rating = ?`,
          [uid, bookRows[0].book_id, rating, rating],
        );
      }
    }

    res.json({ message: "Review updated" });
  } catch (error) {
    sendServerError(res, "Edit review error", error);
  }
});

// ── Delete a review: DELETE /api/review/:id ──
app.delete("/api/review/:id", async (req, res) => {
  try {
    const reviewId = parsePositiveInt(req.params.id);
    const uid = parsePositiveInt(req.body.uid);

    if (!reviewId || !uid) {
      return res.status(400).json({ error: "review id and uid are required" });
    }

    const [rows] = await pool.execute(
      `SELECT uid FROM reviews WHERE review_id = ?`,
      [reviewId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Review not found" });
    }
    if (rows[0].uid !== uid) {
      return res.status(403).json({ error: "You can only delete your own reviews" });
    }

    await pool.execute(`DELETE FROM reviews WHERE review_id = ?`, [reviewId]);
    res.json({ message: "Review deleted" });
  } catch (error) {
    sendServerError(res, "Delete review error", error);
  }
});

ensureDatabaseSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database setup error:", error);
    process.exit(1);
  });
