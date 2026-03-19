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

To serve locally:

```bash
python -m http.server 8000
```

Can then see rendered version of website at: http://localhost:8000

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
