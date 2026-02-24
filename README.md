[![Build and Deploy Pages](https://github.com/clewis7/compsci516-project/actions/workflows/pages.yaml/badge.svg?branch=main)](https://github.com/clewis7/compsci516-project/actions/workflows/pages.yaml)
# compsci516-project

Project for Duke COMPSCI 516: Database Systems (Spring 2026)

Homepage for `betterreads`.

To serve locally:

```bash
python -m http.server 8000
```

Can then see rendered version of website at: http://localhost:8000

### Load dataset into MySQL

**Docker (recommended):**
```bash
chmod +x scripts/load_mysql_docker.sh
./scripts/load_mysql_docker.sh data/book_data.sql
