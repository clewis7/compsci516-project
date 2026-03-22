const express = require("express");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();
const PORT = 3001;

const pool = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "root",
  database: "books",
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const field = (req.query.field || "author").trim().toLowerCase();

    if (!q) {
      return res.json([]);
    }

    let sql;
    let params = [`%${q}%`];

    if (field === "title") {
      sql = `
        SELECT book_id, title, author
        FROM books
        WHERE title LIKE ?
        ORDER BY title ASC
        LIMIT 8
      `;
    } else if (field === "author") {
      sql = `
        SELECT book_id, title, author
        FROM books
        WHERE author LIKE ?
        ORDER BY author ASC
        LIMIT 5
      `;
    } else if (field === "genre") {
      sql = `
        SELECT DISTINCT b.book_id, b.title, b.author
        FROM books b
        JOIN book_genres bg ON b.hardcover_id = bg.hardcover_id
        JOIN genres g ON bg.genre_id = g.genre_id
        WHERE g.genre_name LIKE ?
        ORDER BY b.title ASC
        LIMIT 8;
      `;
    }

    const [rows] = await pool.execute(sql, [`%${q}%`]);
    res.json(rows);
  } catch (error) {
    console.error("Search error:", error);
    res.status(500).json({ error: "Server error" });
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
    const bookId = req.params.id;

    // Get the book's primary genre
    const [books] = await pool.execute(
      `SELECT primary_genre FROM books WHERE book_id = ?`,
      [bookId]
    );

    if (books.length === 0) {
      return res.status(404).json({ error: "Book not found" });
    }

    const genre = books[0].primary_genre;

    if (!genre) {
      return res.json([]);
    }

    // Get 5 random books from the same genre, excluding the current book
    const [rows] = await pool.execute(
      `SELECT book_id, title, author, cover_image_url, average_rating
       FROM books
       WHERE primary_genre = ? AND book_id != ?
       ORDER BY RAND()
       LIMIT 5`,
      [genre, bookId]
    );

    res.json(rows);
  } catch (error) {
    console.error("Recommendations error:", error);
    res.status(500).json({ error: "Server error" });
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
