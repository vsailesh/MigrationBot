# MigrationBot Data Cleaning Integration Guide

## Overview

The data cleaning functionality has been fully integrated into the MigrationBot Node.js application. This guide explains how to use, configure, and extend the cleaning system.

## Architecture

```
MigrationBot
├── server.js                    # Main entry point with dataCleaner initialization
├── frontend/
│   ├── index.html              # HTML with cleaning dashboard UI
│   ├── app.js                  # Frontend JS with cleaning dashboard logic
│   └── style.css               # Dashboard styling
├── src/
│   ├── dataCleaner.js          # Core cleaning engine (469 lines)
│   ├── routes/
│   │   └── api.js              # Cleaning endpoints
│   └── azure/
│       ├── blobClient.js       # Azure Blob integration
│       └── sqlClient.js        # SQL metadata storage
└── schemas/
    ├── aetna.json              # Aetna project schema
    └── carefirst.json          # CareFirst project schema
```

## Core Components

### 1. **DataCleaner Class** (`src/dataCleaner.js`)

The main cleaning engine with these key features:

#### Data Processing
- **Multi-format support**: Excel (XLSX/XLS) and CSV files
- **Schema validation**: Validates data against project-specific schemas
- **Type conversion**: Automatic type casting (string, number, date, boolean)
- **Column standardization**: Maps and standardizes column names

#### Azure Integration
- **Blob Storage**: Direct upload of cleaned files
- **SQL Server**: Metadata tracking with FileProcessingMetadata table
- **Error handling**: Quarantine folder for failed files, retry mechanism

#### Configuration
```javascript
// Environment variables (optional)
CLEANING_POLLING_INTERVAL_MINUTES=15
SHAREPOINT_SITE_URL=https://yoursite.sharepoint.com/
AZURE_STORAGE_CONNECTION_STRING=...
AZURE_CONTAINER=uhcncdata
SQL_CONNECTION_STRING=...
QUARANTINE_FOLDER=failed_data
RETRY_FOLDER=need_retry
MAX_RETRIES=3
ENABLE_CLEANING_MONITORING=true
```

### 2. **API Endpoints** (`src/routes/api.js`)

#### Status & Monitoring
```
GET /api/cleaning/status              # Get system status and metrics
POST /api/cleaning/scan                # Trigger manual cleaning scan
GET /api/cleaning/logs                 # Get processing logs (limit default 50)
```

#### Statistics & Reporting
```
GET /api/cleaning/stats                # Get processing statistics
GET /api/cleaning/failed-files         # List failed files needing attention
GET /api/cleaning/projects             # List available projects and schemas
```

#### Project Management
```
GET /api/cleaning/projects/:name/schema   # Get schema details for a project
POST /api/cleaning/retry/:fileId          # Retry processing a failed file
```

### 3. **Frontend Dashboard** (`frontend/`)

Interactive cleaning dashboard with:
- **System Status**: Real-time cleaning system status
- **Today's Metrics**: Files processed, pending, and failed
- **Project Statistics**: Per-project processing stats and success rates
- **Failed Files Report**: List of files that need attention
- **Manual Controls**: Trigger scans, refresh statistics

## Setup Instructions

### Step 1: Environment Configuration

Create or update `.env` file:

```bash
# Enable automated monitoring (optional)
ENABLE_CLEANING_MONITORING=true
CLEANING_POLLING_INTERVAL_MINUTES=15

# Azure Blob Storage
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;...
AZURE_CONTAINER=uhcncdata

# SQL Server for metadata
SQL_CONNECTION_STRING=Server=your-server.database.windows.net;Database=YourDB;...

# SharePoint (if using SharePoint integration)
SHAREPOINT_SITE_URL=https://yourcompany.sharepoint.com/sites/yoursite/

# Error handling
QUARANTINE_FOLDER=failed_data
RETRY_FOLDER=need_retry
MAX_RETRIES=3
```

### Step 2: Create Project Schemas

Add JSON schema files to `schemas/` directory:

**Format**: `schemas/{project-name}.json`

Example (Aetna):
```json
{
  "projectName": "Aetna",
  "columns": {
    "MemberId": { "type": "string", "required": true },
    "FirstName": { "type": "string", "required": true },
    "DateOfBirth": { "type": "date", "required": false },
    "Amount": { "type": "number", "required": false }
  },
  "requiredFields": ["MemberId", "FirstName"],
  "dataQualityRules": [
    { "field": "MemberId", "rule": "non_empty" },
    { "field": "DateOfBirth", "rule": "valid_date" }
  ]
}
```

### Step 3: Start the Server

```bash
# Development mode (auto-reload)
npm run dev

# Production mode
npm start
```

Access dashboard: `http://localhost:3001` → Click "🧹 Data Cleaning" tab

## Usage Examples

### 1. Check System Status

```bash
curl http://localhost:3001/api/cleaning/status
```

Response:
```json
{
  "status": "running",
  "last_scan": "2026-03-10T14:25:36.000Z",
  "monitoring_enabled": true,
  "polling_interval_minutes": 15,
  "files_processed_today": 45,
  "pending_files": 3,
  "failed_files": 2
}
```

### 2. Trigger Manual Cleaning Scan

```bash
curl -X POST http://localhost:3001/api/cleaning/scan
```

### 3. Get Processing Statistics

```bash
curl http://localhost:3001/api/cleaning/stats
```

### 4. List Failed Files

```bash
curl http://localhost:3001/api/cleaning/failed-files
```

### 5. Retry a Failed File

```bash
curl -X POST http://localhost:3001/api/cleaning/retry/file-123
```

## Data Processing Pipeline

```
SharePoint Source File
    ↓
┌─────────────────────────────┐
│  Format Detection           │ XLSX/CSV detection
│  (detectFileFormat)         │
└─────────────────────────────┘
    ↓
┌─────────────────────────────┐
│  Schema Validation          │ Check against project schema
│  (validateAndStandardize)   │ Detect new columns, **identify missing expected columns**
└─────────────────────────────┘
    ↓
┌─────────────────────────────┐
│  Type Conversion            │ Convert to correct data types
│  (convertColumnType)        │ Handle missing values
└─────────────────────────────┘
    ↓
┌─────────────────────────────┐
│  Data Quality Checks        │ Validate data quality rules
│  (applyDataQuality)         │ Flag issues
└─────────────────────────────┘
    ↓
    Success? [YES] → Azure Blob Storage + SQL Metadata
    Success? [NO]  → Quarantine Folder + Error Log
```

## Key Features

### 1. **Project-Specific Schemas**
Each project (Aetna, CareFirst, etc.) has its own schema with:
- Custom column definitions
- Type specifications
- Required field validation
- Data quality rules

### 2. **Automatic Error Handling**
- Failed files automatically moved to quarantine folder
- Detailed error logging in SQL Server
- Retry mechanism (configurable max retries)
- Email notifications (can be extended)

### 3. **Missing Column Detection**
- Schema validation now flags any expected columns that are absent from the source file
- Missing columns are logged as warnings, inserted in metadata (`MissingColumns`), and defaulted to `null` (or project‑specified value)
- Operators can review missing‑column cases via the dashboard and take corrective action


### 3. **Metadata Tracking**
Every processed file creates a metadata record:
```sql
FileProcessingMetadata
├── FileId (GUID)
├── FileName
├── ProjectName
├── ProcessingStatus (Success/Failed)
├── ProcessingStartTime
├── ProcessingEndTime
├── RowCount
├── ErrorMessage
└── RetryCount
```

### 4. **Monitoring & Alerts**
- Real-time dashboard showing:
  - Files processed today
  - Pending files
  - Failed files
  - Per-project success rates
- Configurable polling intervals (default 15 minutes)
- Manual scan trigger option

### 5. **Extensibility**
Easily add new projects:
```javascript
// 1. Create schema file: schemas/newproject.json
// 2. Restart service (automatic schema loading)
// 3. Files for 'newproject' automatically validated
```

## Integration with Existing MigrationBot

The cleaning system integrates seamlessly with existing components:

1. **SharePoint Integration**: Can detect files from SharePoint and queue for cleaning
2. **Azure Blob Storage**: Cleaned files stored in configured container
3. **SQL Server**: Metadata stored for auditing and processing history
4. **ADF Pipelines**: Cleaned files can trigger downstream ADF pipeline processing

## Troubleshooting

### Issue: "Schema not found for project"
**Solution**: Verify schema file exists in `schemas/` directory with correct JSON format

### Issue: "Failed to connect to Azure Storage"
**Solution**: Check `AZURE_STORAGE_CONNECTION_STRING` in `.env` file

### Issue: "No processing statistics available"
**Solution**: 
1. Ensure `SQL_CONNECTION_STRING` is configured
2. Run a manual scan using the dashboard
3. Allow a few moments for data to be recorded

### Issue: Files stuck in quarantine folder
**Solution**:
1. Check error message in dashboard
2. Fix the underlying data issue
3. Use "Retry" button to reprocess

## Performance Considerations

- **Large files** (>100MB): Consider increasing timeout values
- **High volume**: Adjust `CLEANING_POLLING_INTERVAL_MINUTES` based on load
- **SQL Server**: Ensure FileProcessingMetadata table has proper indexing
- **Blob Storage**: Monitor storage costs for failed file quarantine

## Security

1. **Connection Strings**: Never commit `.env` to version control
2. **SharePoint Auth**: Uses existing MSAL token management
3. **SQL Server**: Requires SQL authentication or Managed Identity
4. **Blob Storage**: Uses connection string or Managed Identity
5. **Quarantine Folder**: Restrict access to authorized users only

## Future Enhancements

Potential improvements:
- [ ] Email notifications for failed files
- [ ] Webhook integration for external systems
- [ ] Custom validation rules per column
- [ ] Data profiling and quality reporting
- [ ] Scheduled cleaning jobs
- [ ] Data enrichment capabilities
- [ ] Audit trail with change tracking
- [ ] Performance optimization for large datasets

## Support

For issues or questions:
1. Check `CLEANING_SETUP.md` (this file)
2. Review error logs in quarantine folder
3. Check SQL Server metadata table for detailed errors
4. Review application console logs

---

**Last Updated**: March 10, 2026
**Version**: 1.0.0
**Status**: Production Ready
