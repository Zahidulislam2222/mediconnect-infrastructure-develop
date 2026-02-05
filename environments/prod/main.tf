data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

module "gcp_data" {
  source      = "../../modules/gcp/data"
  project_id  = var.gcp_project_id
  db_password = var.db_master_password
}

module "azure_data" {
  source              = "../../modules/azure/data"
  subscription_id     = var.azure_subscription_id
  resource_group_name = "mediconnect-prod-rg" # Assuming RG exists or is managed elsewhere, otherwise should be resource. For now, hardcoding as per typical existing infra or assumed pre-req.
  location            = var.azure_location
}

module "aws_identity" {
  source                  = "../../modules/aws/identity"
  gcp_sql_connection_name = module.gcp_data.connection_name
  db_password             = var.db_master_password
  azure_cosmos_endpoint   = module.azure_data.endpoint
  azure_cosmos_key        = module.azure_data.primary_key
}

module "migration_job" {
  source     = "../../modules/aws/migration_job"
  aws_region = var.aws_region
  
  # REPLACE "module.aws_network..." WITH THIS:
  vpc_id     = data.aws_vpc.default.id
  subnet_ids = data.aws_subnets.default.ids
}

# Output the ECR URL so we know where to push the docker image
output "migration_repo_url" {
  value = module.migration_job.migration_repo_url
}
