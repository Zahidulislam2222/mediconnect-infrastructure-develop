resource "aws_ssm_parameter" "gcp_sql_connection_name" {
  name  = "/mediconnect/prod/gcp/sql/connection_name"
  type  = "String"
  value = var.gcp_sql_connection_name
}

resource "aws_ssm_parameter" "db_master_password" {
  name  = "/mediconnect/prod/db/master_password"
  type  = "SecureString"
  value = var.db_password
}

resource "aws_ssm_parameter" "azure_cosmos_endpoint" {
  name  = "/mediconnect/prod/azure/cosmos/endpoint"
  type  = "String"
  value = var.azure_cosmos_endpoint
}

resource "aws_ssm_parameter" "azure_cosmos_key" {
  name  = "/mediconnect/prod/azure/cosmos/primary_key"
  type  = "SecureString"
  value = var.azure_cosmos_key
}
