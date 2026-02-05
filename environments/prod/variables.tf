variable "aws_region" {
  description = "AWS Region"
  type        = string
  default     = "us-east-1"
}

variable "gcp_project_id" {
  description = "GCP Project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP Region"
  type        = string
  default     = "us-central1"
}

variable "azure_subscription_id" {
  description = "Azure Subscription ID"
  type        = string
}

variable "db_master_password" {
  description = "Master password for all databases"
  type        = string
  sensitive   = true
}

variable "azure_location" {
  description = "The Azure Region for resources"
  type        = string
  default     = "westus" # We change this to westus to bypass the East US crowd
}