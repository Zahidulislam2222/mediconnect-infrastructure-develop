FROM python:3.9-slim

# Install system dependencies for Postgres
RUN apt-get update && apt-get install -y libpq-dev gcc && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY migrate.py .

CMD ["python", "migrate.py"]