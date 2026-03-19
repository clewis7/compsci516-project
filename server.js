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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
