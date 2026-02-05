output "endpoint" {
  value = azurerm_cosmosdb_account.db.endpoint
}

output "primary_key" {
  value     = azurerm_cosmosdb_account.db.primary_key
  sensitive = true
}
