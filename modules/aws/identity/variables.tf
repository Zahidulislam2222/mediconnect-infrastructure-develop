variable "gcp_sql_connection_name" {
  description = "GCP Cloud SQL connection name"
  type        = string
}

variable "db_password" {
  description = "The database master password"
  type        = string
  sensitive   = true
}

variable "azure_cosmos_endpoint" {
  description = "Azure Cosmos DB endpoint"
  type        = string
}

variable "azure_cosmos_key" {
  description = "Azure Cosmos DB primary key"
  type        = string
  sensitive   = true
}
