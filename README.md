# MigrationBot

A Node.js/Express application for cleaning and migrating data files from SharePoint into Azure Blob Storage and SQL Server. It supports project-specific schemas, data quality rules, and automated tracking of file processing metadata.

**Recent Enhancements:**
- Schema-driven missing column detection – flags and records any expected columns missing from a source file, then fills them with `null` or project‑defined defaults.
- Metadata now includes `MissingColumns` (JSON array) for easier auditing and troubleshooting.

