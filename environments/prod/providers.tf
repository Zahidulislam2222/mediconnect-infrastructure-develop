terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

provider "google" {
  project     = var.gcp_project_id
  region      = var.gcp_region
  credentials = file("gcp_key.json")
}

provider "azurerm" {
  features {}
  subscription_id = var.azure_subscription_id
}
