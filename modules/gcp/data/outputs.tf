output "connection_name" {
  value       = google_sql_database_instance.master.connection_name
  description = "The connection name of the master instance to be used in connection strings"
}

output "public_ip_address" {
  value       = google_sql_database_instance.master.public_ip_address
  description = "The public IP address of the master instance"
}
