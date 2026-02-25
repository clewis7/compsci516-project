import mysql.connector
import requests
import time
import json


# 1. Database Connection Settings, please change it to your own settings. 

# db_config = {
#     "host": "localhost",
#     "user": "root",
#     "password": "yourPassword",
#     "database": "yourDatabase"
# }

# 2. Hardcover API Configuration, please use your own authorization key
# API_URL = "https://api.hardcover.app/v1/graphql"
# HEADERS = {yourHead}

# List of genres to fetch (200 books each)


# Check if your connection works

GENRES = [
    "Fantasy", "Sci-Fi", "Romance", "Mystery", "Horror", 
    "Thriller", "Historical Fiction", "Biography", "Self Help", "History"
]

TOP_18_GENRES = [
    "Fiction",
    "Fantasy",
    "Young Adult",
    "Adventure",
    "Science Fiction",
    "Classics",
    "Comics",
    "History",
    "LGBTQ",
    "Romance",
    "War",
    "Juvenile Fiction",
    "Comics & Graphic Novels",
    "Biography",
    "Mystery",
    "Dystopian",
    "Religion",
    "General",
]

REST_22_GENRES = [
    "Biography & Autobiography",
    "Juvenile Nonfiction",
    "Aliens",
    "Space",
    "Business & Economics",
    "Philosophy",
    "Nonfiction",
    "Young Adult Fiction",
    "Science",
    "Thriller",
    "Computers",
    "Psychology",
    "Suspense",
    "Poetry",
    "Literature",
    "Humor",
    "Politics",
    "Social Science",
    "Travel",
    "Mathematics",
    "Cooking",
    "Political Science",
]

def check_connection():
    # Simplest possible query: just get 5 book titles
    query = "{ books(limit: 5) { title } }"
    
    try:
        response = requests.post(API_URL, json={'query': query}, headers=HEADERS)
        print(f"Status Code: {response.status_code}")
        
        data = response.json()
        if 'errors' in data:
            print("API Error:", json.dumps(data['errors'], indent=2))
        elif 'data' in data and data['data']['books']:
            print("Connection Successful! Found these books:")
            for book in data['data']['books']:
                print(f" - {book['title']}")
        else:
            print("Connected, but returned no data. Check if your token has permissions.")
            
    except Exception as e:
        print(f"Network or Script Error: {e}")

import json, time, requests

def fetch_books_by_genre_via_search_genres(
    genre: str,
    n: int = 200,
    per_page: int = 50,
    max_pages: int = 50,
    sleep_sec: float = 1.1,
):
    QUERY = """
    query SearchBooks($q: String!, $per_page: Int!, $page: Int!, $fields: String!, $weights: String!, $sort: String!) {
      search(
        query: $q,
        query_type: "Book",
        per_page: $per_page,
        page: $page,
        fields: $fields,
        weights: $weights,
        sort: $sort
      ) {
        results
      }
    }
    """

    genre_lc = genre.strip().lower()
    collected = []
    seen = set()

    variables_base = {
        "q": genre,
        "fields": "genres",
        "weights": "10",
        "sort": "_text_match:desc,users_count:desc",
        "per_page": per_page,
    }

    for page in range(1, max_pages + 1):
        variables = dict(variables_base)
        variables["page"] = page

        resp = requests.post(API_URL, headers=HEADERS, json={"query": QUERY, "variables": variables}, timeout=60).json()
        if "errors" in resp:
            raise RuntimeError(resp["errors"])

        results = resp["data"]["search"]["results"]
        if isinstance(results, str):
            results = json.loads(results)

        hits = results.get("hits", []) if isinstance(results, dict) else []
        if not hits:
            break

        for h in hits:
            doc = h.get("document", {})
            if not isinstance(doc, dict):
                continue

            bid = doc.get("id")
            if not bid or bid in seen:
                continue

            genres = doc.get("genres") or []
            if isinstance(genres, list) and any((g or "").strip().lower() == genre_lc for g in genres):
                seen.add(bid)
                collected.append(doc)

            if len(collected) >= n:
                return collected[:n]

        time.sleep(sleep_sec)

    return collected[:n]


def ingest_book_docs(doc_list: list):
    """
    Upsert into books + insert mappings for ALL doc['genres'] that exist in genres table.
    Returns (new_books_inserted, books_processed).
    """
    if not doc_list:
        return (0, 0)

    conn = mysql.connector.connect(**db_config)
    try:
        cur = conn.cursor()

        cur.execute("SELECT genre_id, genre_name FROM genres")
        genre_map = {name: gid for (gid, name) in cur.fetchall()}

        # Track how many new books were inserted
        new_books = 0
        processed = 0

        BOOK_UPSERT = """
        INSERT INTO books (hardcover_id, title, author, isbn, average_rating, description, cover_image_url, primary_genre, pages)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ON DUPLICATE KEY UPDATE
          title=VALUES(title),
          author=VALUES(author),
          isbn=VALUES(isbn),
          average_rating=VALUES(average_rating),
          description=VALUES(description),
          cover_image_url=VALUES(cover_image_url),
          pages=VALUES(pages);
        """

        MAP_INSERT = "INSERT IGNORE INTO book_genres (hardcover_id, genre_id) VALUES (%s, %s)"

        cur.execute("SELECT hardcover_id FROM books")
        existing_ids = set(r[0] for r in cur.fetchall())

        book_vals = []
        map_vals = []

        for doc in doc_list:
            bid = doc.get("id")
            if not bid:
                continue
            hardcover_id = str(bid).strip()

            title = (doc.get("title") or "")[:255] or None

            author_names = doc.get("author_names") or []
            if isinstance(author_names, list) and author_names:
                author = ", ".join([a for a in author_names if a])[:255]
            else:
                author = "Unknown"

            isbn = None
            isbns = doc.get("isbns") or []
            if isinstance(isbns, list) and isbns:
                isbn = str(isbns[0])[:20]

            avg = None
            try:
                if doc.get("rating") is not None:
                    avg = float(doc.get("rating"))
            except Exception:
                avg = None

            description = doc.get("description")
            if description is not None:
                description = str(description)

            cover_url = None
            img = doc.get("image")
            if isinstance(img, dict):
                cover_url = img.get("url")
            if cover_url:
                cover_url = str(cover_url)[:500]

            pages = doc.get("pages")
            try:
                pages = int(pages) if pages is not None else None
            except Exception:
                pages = None

            # primary_genre = first genre in the list
            doc_genres = doc.get("genres") or []
            primary_genre = (doc_genres[0] if isinstance(doc_genres, list) and doc_genres else None)
            if primary_genre:
                primary_genre = primary_genre[:100]

            book_vals.append((hardcover_id, title, author, isbn, avg, description, cover_url, primary_genre, pages))

            if isinstance(doc_genres, list):
                for g in doc_genres:
                    if not isinstance(g, str):
                        continue
                    g = g.strip()
                    if not g:
                        continue
                    gid = genre_map.get(g)
                    if gid is not None:
                        map_vals.append((hardcover_id, gid))

            if hardcover_id not in existing_ids:
                new_books += 1
                existing_ids.add(hardcover_id)

            processed += 1

        if book_vals:
            cur.executemany(BOOK_UPSERT, book_vals)
        if map_vals:
            cur.executemany(MAP_INSERT, map_vals)

        conn.commit()
        return (new_books, processed)

    finally:
        conn.close()

def ingest_top_genres(genres: list, n_per_genre: int = 200):
    total_new = 0
    total_processed = 0

    for g in genres:
        print(f"\n=== Genre: {g} ===")
        docs = fetch_books_by_genre_via_search_genres(g, n=n_per_genre)
        print(f"Fetched {len(docs)} docs for {g}")

        new_books, processed = ingest_book_docs(docs)
        total_new += new_books
        total_processed += processed

        print(f"Inserted/updated {processed} books for {g} (new unique books: {new_books})")

    print("\n=== DONE ===")
    print("Total processed:", total_processed)
    print("Total new unique books inserted:", total_new)

if __name__ == "__main__":
    check_connection()
    ingest_top_genres(TOP_18_GENRES, n_per_genre=300)
    ingest_top_genres(REST_22_GENRES, n_per_genre=200)