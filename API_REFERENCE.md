# Data Cleaning API Reference

## Base URL

```
http://localhost:3001/api
```

All endpoints use JSON for request/response bodies.

---

## Status & Monitoring Endpoints

### GET /cleaning/status

Get current cleaning system status and metrics.

**Response:**
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

**Status Values:**
- `running` - Monitoring is active
- `stopped` - Monitoring is disabled

**Example:**
```bash
curl http://localhost:3001/api/cleaning/status
```

---

### POST /sharepoint/migrate (with optional cleaning)

Trigger migration of selected SharePoint items. You can also request that files be
cleaned before upload by setting `clean=true` (the cleaning pipeline infers the
project from the SharePoint folder path).

**Request body** (JSON):

```json
{
  "items": [{ "id": "<file-id>", "name": "file.xlsx" }, ...],
  "containerName": "destination-container",
  "prefix": "optional/prefix",
  "clean": true,            // optional; run cleaning first
  "folderPath": "Shared Documents/Aetna" // optional; used by cleaner
}
```

**Response:**

```json
{
  "ok": true,
  "migrated": [ { "name": "foo.xlsx", "blobPath": "..." }, ... ],
  "cleaned": [ { "name": "foo.xlsx", "result": { ... } }, ... ]
}
```

---

### POST /cleaning/scan

Trigger a manual cleaning scan immediately.

**Request:**
```bash
curl -X POST http://localhost:3001/api/cleaning/scan
```

**Response:**
```json
{
  "message": "Cleaning scan initiated successfully",
  "scan_id": "1678543536000",
  "status": "completed",
  "timestamp": "2026-03-10T14:25:36.000Z"
}
```

---

### GET /cleaning/logs

Get recent processing logs (including any missing columns detected).

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| limit | number | 50 | Maximum number of logs to return |

**Response:**
```json
{
  "logs": [
    {
      "timestamp": "2026-03-10T14:20:00.000Z",
      "file": "test_data.xlsx",
      "project": "Aetna",
      "status": "success",
      "rows_processed": 150,
      "missing_columns": []
    }
  ],
  "total_available": 127,
  "limit_used": 50
}
```

**Example:**
```bash
# Get last 100 logs
curl http://localhost:3001/api/cleaning/logs?limit=100
```

---

## Statistics & Reporting Endpoints

### GET /cleaning/stats

Get processing statistics and performance metrics.

**Response:**
```json
{
  "summary": {
    "total_files_processed": 342,
    "successful": 335,
    "failed": 7,
    "success_rate": "97.95%"
  },
  "projects": [
    {
      "name": "Aetna",
      "files_processed": 200,
      "last_processed": "2026-03-10T14:25:00.000Z"
    },
    {
      "name": "CareFirst",
      "files_processed": 142,
      "last_processed": "2026-03-10T14:20:00.000Z"
    }
  ],
  "generated_at": "2026-03-10T14:30:00.000Z"
}
```

**Example:**
```bash
curl http://localhost:3001/api/cleaning/stats
```

---

### GET /cleaning/failed-files

Get list of files that failed processing (includes any missing columns detected).

**Response:**
```json
{
  "failed_files": [
    {
      "filename": "bad_data_001.xlsx",
      "path": "failed_data/bad_data_001.xlsx",
      "size_bytes": 45821,
      "failed_at": "2026-03-10T13:45:00.000Z",
      "error_message": "Schema mismatch: Missing required column 'MemberId'",
      "missing_columns": ["MemberId","LastName"],
      "retry_count": 0
    },
    {
      "filename": "corrupted_file.csv",
      "path": "failed_data/corrupted_file.csv",
      "size_bytes": 1024,
      "failed_at": "2026-03-10T12:30:00.000Z",
      "error_message": "Invalid CSV format",
      "retry_count": 1
    }
  ],
  "total_count": 2
}
```

**Example:**
```bash
curl http://localhost:3001/api/cleaning/failed-files
```

---

## Project Management Endpoints

### GET /cleaning/projects

Get list of available projects and their schemas.

**Response:**
```json
{
  "projects": [
    {
      "name": "Aetna",
      "key": "aetna",
      "schema_file": "schemas/aetna.json",
      "column_count": 52,
      "required_fields": 8,
      "data_quality_rules": 15,
      "last_updated": "2026-03-10T14:00:00.000Z"
    },
    {
      "name": "CareFirst",
      "key": "carefirst",
      "schema_file": "schemas/carefirst.json",
      "column_count": 28,
      "required_fields": 5,
      "data_quality_rules": 8,
      "last_updated": "2026-03-10T14:00:00.000Z"
    }
  ]
}
```

**Example:**
```bash
curl http://localhost:3001/api/cleaning/projects
```

---

### GET /cleaning/projects/:name/schema

Get detailed schema information for a specific project.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Project name (case-insensitive) |

**Response:**
```json
{
  "project": "aetna",
  "schema": {
    "projectName": "Aetna",
    "columns": {
      "MemberId": {
        "type": "string",
        "required": true
      },
      "FirstName": {
        "type": "string",
        "required": true
      },
      "Amount": {
        "type": "number",
        "required": false
      },
      "DateOfBirth": {
        "type": "date",
        "required": false
      }
    },
    "requiredFields": ["MemberId", "FirstName"],
    "dataQualityRules": [
      {
        "field": "MemberId",
        "rule": "non_empty"
      },
      {
        "field": "DateOfBirth",
        "rule": "valid_date"
      }
    ]
  }
}
```

**Example:**
```bash
curl http://localhost:3001/api/cleaning/projects/aetna/schema
```

**Error Response (404):**
```json
{
  "error": "Project schema not found"
}
```

---

## File Management Endpoints

### POST /cleaning/retry/:fileId

Retry processing a file that previously failed.

**Path Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| fileId | string | ID of the file to retry |

**Response:**
```json
{
  "message": "File abc-123-def queued for retry",
  "fileId": "abc-123-def",
  "status": "queued",
  "retry_count": 1,
  "timestamp": "2026-03-10T14:30:00.000Z"
}
```

**Example:**
```bash
curl -X POST http://localhost:3001/api/cleaning/retry/abc-123-def
```

**Error Response (404):**
```json
{
  "error": "File not found in quarantine"
}
```

---

## Error Responses

All endpoints return standard error responses:

### Common Error Codes

**400 Bad Request**
```json
{
  "error": "Invalid request parameters"
}
```

**404 Not Found**
```json
{
  "error": "Resource not found"
}
```

**500 Internal Server Error**
```json
{
  "error": "Internal server error message"
}
```

---

## Authentication

Currently, there is no authentication required. For production use, consider adding:
- API key validation
- JWT tokens
- Azure AD integration

---

## Rate Limiting

Currently, there is no rate limiting. For production use, consider implementing:
- Per-IP rate limits
- Per-API-key rate limits
- Endpoint-specific limits

---

## Examples

### Example 1: Check System Status and Run Scan

```bash
#!/bin/bash

# Check status
echo "Checking cleaning system status..."
curl -s http://localhost:3001/api/cleaning/status | jq .

# If running, trigger a scan
echo "Triggering manual cleaning scan..."
curl -s -X POST http://localhost:3001/api/cleaning/scan | jq .

# Wait a moment and check stats
sleep 2
echo "Getting updated statistics..."
curl -s http://localhost:3001/api/cleaning/stats | jq .
```

### Example 2: Monitor For Failed Files

```bash
#!/bin/bash

while true; do
  FAILED=$(curl -s http://localhost:3001/api/cleaning/failed-files | jq '.total_count')
  echo "Failed files: $FAILED"
  
  if [ "$FAILED" -gt 0 ]; then
    echo "Failed files detected! Details:"
    curl -s http://localhost:3001/api/cleaning/failed-files | jq '.failed_files[] | {filename, error_message}'
  fi
  
  sleep 60
done
```

### Example 3: Get Project Schema and Display

```bash
#!/bin/bash

PROJECT=$1
if [ -z "$PROJECT" ]; then
  echo "Usage: $0 <project-name>"
  exit 1
fi

echo "Schema for project: $PROJECT"
curl -s http://localhost:3001/api/cleaning/projects/$PROJECT/schema | jq '.'
```

---

## Webhook Integration (Future)

Future versions may support webhooks for:
- File processing completion
- Processing failures
- Quota alerts
- Schedule triggers

---

## Performance Tips

1. **Pagination**: For large result sets, use `?limit=` parameter
2. **Caching**: Cache project schema data (rarely changes)
3. **Polling**: Use configurable polling intervals, not constant polling
4. **Batch Operations**: Combine multiple operations where possible
5. **Timeout Handling**: Implement appropriate timeouts for your use case

---

## Troubleshooting

### 500 Error on Endpoint

1. Check application logs for detailed error message
2. Verify database connectivity
3. Check environment variables are set correctly
4. Ensure schema files exist in `schemas/` directory

### Empty Statistics

1. Run at least one cleaning scan first
2. Wait for data to be recorded in SQL Server
3. Check database connection string is correct

### File Not Retrying

1. Verify file exists in quarantine folder
2. Check file ID is correct
3. Review error message for specific issue

---

**Last Updated**: March 10, 2026
**Version**: 1.0.0
**API Status**: Stable
