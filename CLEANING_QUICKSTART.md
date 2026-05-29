# Quick Start: Data Cleaning in MigrationBot

## 1-Minute Setup

### Option A: Minimal Setup (No Monitoring)

`.env` file:
```
AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=...
SQL_CONNECTION_STRING=Server=your-server.database.windows.net;Database=YourDB;User Id=sa;Password=...
```

### Option B: Full Setup (With Monitoring)

`.env` file:
```
ENABLE_CLEANING_MONITORING=true
CLEANING_POLLING_INTERVAL_MINUTES=15
AZURE_STORAGE_CONNECTION_STRING=...
AZURE_CONTAINER=uhcncdata
SQL_CONNECTION_STRING=...
SHAREPOINT_SITE_URL=https://yourcompany.sharepoint.com/sites/yoursite/
QUARANTINE_FOLDER=failed_data
RETRY_FOLDER=need_retry
MAX_RETRIES=3
```

## Add Your First Project Schema

Create `schemas/myproject.json`:

```json
{
  "projectName": "MyProject",
  "columns": {
    "Id": { "type": "string", "required": true },
    "Name": { "type": "string", "required": true },
    "Email": { "type": "string", "required": false },
    "Amount": { "type": "number", "required": false },
    "ProcessedDate": { "type": "date", "required": false }
  },
  "requiredFields": ["Id", "Name"],
  "dataQualityRules": [
    { "field": "Id", "rule": "non_empty" }
  ]
}
```

## Run the Service

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Visit http://localhost:3001
# Click "🧹 Data Cleaning" tab in sidebar
```

## Use the Dashboard

1. **Check Status**: See "System Status" card
2. **Run Scan**: Click "🔄 Run Cleaning Scan" button
3. **View Results**: Check "📁 Project Statistics" section
4. **Review Errors**: See "❌ Recent Failed Files" section (now shows any missing expected columns for each record)

## API Quick Reference

```bash
# Check status
curl http://localhost:3001/api/cleaning/status

# Run scan
curl -X POST http://localhost:3001/api/cleaning/scan

# Get statistics
curl http://localhost:3001/api/cleaning/stats

# List failed files
curl http://localhost:3001/api/cleaning/failed-files

# Get available projects
curl http://localhost:3001/api/cleaning/projects

# Retry a file
curl -X POST http://localhost:3001/api/cleaning/retry/file-id-123
```

## Common Tasks

### Add Another Project

1. Create new schema: `schemas/careplan.json`
2. Restart service
3. Done! The system auto-loads new schemas

### Troubleshoot a Failed File

1. Dashboard → "❌ Recent Failed Files"
2. Click the file to see error details
3. Fix the issue (schema mismatch, bad data, etc.)
4. Click "Retry" button to reprocess

### Change Polling Interval

Edit `.env`:
```
CLEANING_POLLING_INTERVAL_MINUTES=30
```

Then restart the service.

### Disable Monitoring

Edit `.env`:
```
ENABLE_CLEANING_MONITORING=false
```

Or omit the variable entirely.

## Example Data Flows

### Flow 1: Manual File Processing
```
Upload XLSX to SharePoint
    ↓
Dashboard: Click "Run Cleaning Scan"
    ↓
Auto-detect project schema
    ↓
Validate & clean data
    ↓
Upload to Azure Blob
    ↓
Record metadata in SQL
    ↓
Dashboard shows success
```

### Flow 2: Automated Monitoring
```
Enable ENABLE_CLEANING_MONITORING=true
    ↓
Service checks SharePoint every 15 minutes
    ↓
New file detected
    ↓
Auto-clean based on project schema
    ↓
Success → Blob Storage
Failure → Quarantine folder
    ↓
Dashboard updated real-time
```

## Testing Your Setup

1. Create a test file: `test_data.xlsx`
   - Column 1: "Id" (string)
   - Column 2: "Name" (string)
   - Add 5 rows of test data

2. Put file in SharePoint or monitored folder

3. Either:
   - Wait for scheduled scan (if monitoring enabled)
   - Click "🔄 Run Cleaning Scan" on dashboard

4. Check results:
   - Dashboard should show +1 processed file
   - File should appear in Azure Blob storage
   - Metadata should be in SQL Server

## Need Help?

- **Setup issues**: Check `CLEANING_SETUP.md` (detailed guide)
- **API questions**: See "API Endpoints" section in setup guide
- **Errors**: Check quarantine folder and dashboard error messages
- **Logs**: Check application console output

---

**Next**: Read `CLEANING_SETUP.md` for detailed documentation
