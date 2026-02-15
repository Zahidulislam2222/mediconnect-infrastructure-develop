resource "google_sql_database_instance" "master" {
  name             = "mediconnect-sql-v2"
  database_version = "POSTGRES_15"
  region           = var.region

  settings {
    tier              = "db-f1-micro"
    activation_policy = "NEVER"
    availability_type = "ZONAL"

    backup_configuration {
      enabled    = true
      start_time = "04:00"
    }

    ip_configuration {
      ipv4_enabled = true
      require_ssl  = true
    }
  }

  deletion_protection = false # For dev/test ease, usually true for strict prod but following ease of migration context. Can be recommended to change.
}

resource "google_sql_database" "database" {
  name     = "mediconnect_doctors"
  instance = google_sql_database_instance.master.name
}

resource "google_sql_user" "users" {
  name     = "mediconnect_admin"
  instance = google_sql_database_instance.master.name
  password = var.db_password
}
