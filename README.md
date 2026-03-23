# compsci516-project

Project for Duke COMPSCI 516: Database Systems (Spring 2026)

Homepage for `betterreads`.

## Instructions

1. Clone the repo

```bash
git clone https://github.com/clewis7/compsci516-project.git
```

2. Install dependencies

```bash
npm install
```

3. Make sure that [Docker](https://www.docker.com/) is installed and running

```bash
docker --version
```

4. Make sure that docker file is an executable

```bash
sudo chmod +x scripts/load_mysql_docker.sh
```

5. Launch the application

```bash
npm start
```

6. Open the website

```bash
http://localhost:3000
```

Can then see rendered version of website at: http://localhost:3000

----------------------------------------------------------------------

## API notes

### Search

`GET /api/search?q=<query>&field=<title|author|genre>`

- `q` is trimmed before searching; a blank query returns an empty list.
- `field` must be one of `title`, `author`, or `genre`; any other value returns `400`.
- Search returns a consistent book summary shape: `book_id`, `title`, and `author`.
- Genre search uses the `book_genres` and `genres` tables and returns distinct books only.

### Recommendations

`GET /api/recommendations/:id`

- Recommendations are based on overlapping genres for the selected book.
- Results exclude the selected book itself.
- Candidates are ranked by shared genre overlap, then `average_rating`, and the UI can refresh through a weighted sample of strong matches.
- The route returns up to 5 books with the current recommendation card fields.
- Optional query param: `uid=<user id>`
  - When present, books already saved in the user's `read_books` or `want_to_read` lists are excluded.

### Reading Challenges

- `POST /api/challenges`
  - Creates a reading challenge from the logged-in user's current Want to Read list.
- `POST /api/challenges/join`
  - Joins a challenge by invite code.
- `GET /api/challenges/user/:uid`
  - Lists the challenges a user belongs to.
- `GET /api/challenges/:id?uid=<user id>`
  - Returns challenge details, including members and shared books.

Challenge tables are created automatically when the server starts, so the feature works with the existing MySQL seed data.

## Load dataset into MySQL (Docker)

We provide a helper script to start a MySQL 8 container and load our SQL dump.

### 1. Make the script executable and run the loader

```bash
chmod +x scripts/load_mysql_docker.sh

./scripts/load_mysql_docker.sh data/book_data.sql
```

### 2. Running the MySQL database inside of the docker

```bash
mysql -h 127.0.0.1 -P 3306 -u root -proot books
```
