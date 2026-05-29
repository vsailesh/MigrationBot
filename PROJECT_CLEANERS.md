# Project-Specific Data Cleaners

## Overview

Each project (Aetna, CareFirst/CFMD, etc.) now has its own **dedicated cleaning service** that encapsulates project-specific logic and maintains separate statistics.

```
MigrationBot Data Cleaning Architecture
=====================================

Generic DataCleaner (dataCleaner.js)
    ↓
    ├── Aetna Service (aetna_cleaning.js)
    │   ├── Process single files
    │   ├── Process directories
    │   ├── Get Aetna schema
    │   └── Track Aetna statistics
    │
    ├── CareFirst Service (cfmd_cleaning.js)
    │   ├── Process single files
    │   ├── Process directories
    │   ├── Get CareFirst schema
    │   └── Track CareFirst statistics
    │
    └── Custom Services (TEMPLATE_cleaning.js)
        └── Your new projects...
```

---

## Project Cleaners

### 1. Aetna Cleaning Service

**File**: `src/cleaners/aetna_cleaning.js`

**Usage - Direct Import**:
```javascript
import aetnaService from './src/cleaners/aetna_cleaning.js';

// Process single file
const result = await aetnaService.processFile('/path/to/aetna_data.xlsx');

// Process directory
const results = await aetnaService.processDirectory('/path/to/aetna_folder');

// Get schema info
const schema = await aetnaService.getSchemaInfo();

// Get statistics
const stats = aetnaService.getStatistics();
```

**Usage - API Endpoints**:
```bash
# Process single file
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/file.xlsx"}'

# Process directory
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/directory"}'

# Get schema
curl http://localhost:3001/api/cleaning/aetna/schema

# Get statistics
curl http://localhost:3001/api/cleaning/aetna/stats
```

**Response Example**:
```json
{
  "project": "aetna",
  "result": [
    {
      "success": true,
      "project": "aetna",
      "file": "aetna_data.xlsx",
      "rowsProcessed": 245,
      "outputPath": "/output/aetna_data_cleaned.xlsx",
      "uploadedTo": "https://blob.../aetna/aetna_data_cleaned.xlsx",
      "processingTime": 3421
    }
  ],
  "timestamp": "2026-03-12T10:30:00.000Z"
}
```

---

### 2. CareFirst Cleaning Service

**File**: `src/cleaners/cfmd_cleaning.js`

**Usage - Direct Import**:
```javascript
import carefirstService from './src/cleaners/cfmd_cleaning.js';

// Process single file
const result = await carefirstService.processFile('/path/to/carefirst_data.xlsx');

// Process directory
const results = await carefirstService.processDirectory('/path/to/carefirst_folder');

// Get schema info
const schema = await carefirstService.getSchemaInfo();

// Get statistics
const stats = carefirstService.getStatistics();
```

**Usage - API Endpoints**:
```bash
# Process single file
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -H "Content-Type: application/json" \
  -d '{"filePath": "/path/to/file.xlsx"}'

# Process directory
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/path/to/directory"}'

# Get schema
curl http://localhost:3001/api/cleaning/carefirst/schema

# Get statistics
curl http://localhost:3001/api/cleaning/carefirst/stats
```

---

## Creating a New Project Cleaner

### Step 1: Create Project Schema

Create `schemas/yourproject.json`. Make sure the schema reflects the exact column list returned by the upstream SQL `SELECT` for that project; the cleaner will compare incoming files against this list and flag any missing columns.

*Tip:* you can provide an optional `transformations.default_values` object to specify what value should be inserted for any missing column (otherwise `null` is used by default). For example:
```json
"transformations": {
  "default_values": {
    "Status": "Unknown",
    "Amount": 0
  }
}
```
```json
{
  "projectName": "YourProject",
  "columns": {
    "id": { "type": "string", "required": true },
    "name": { "type": "string", "required": true },
    "amount": { "type": "number", "required": false }
  },
  "requiredFields": ["id", "name"],
  "dataQualityRules": [
    { "field": "id", "rule": "non_empty" }
  ]
}
```

### Step 2: Copy Template

Copy `src/cleaners/TEMPLATE_cleaning.js` to your project file:
```bash
cp src/cleaners/TEMPLATE_cleaning.js src/cleaners/yourproject_cleaning.js
```

### Step 3: Customize

Edit `src/cleaners/yourproject_cleaning.js`:

```javascript
// Change these constants
const PROJECT_NAME = 'yourproject';           // Must match schema filename
const PROJECT_DISPLAY_NAME = 'Your Project';

// Class name should follow convention
class YourProjectCleaningService {
  // Customize as needed...
}

// Export with consistent naming
export const yourprojectService = new YourProjectCleaningService();
export default yourprojectService;
```

### Step 4: Add API Routes

Update `src/routes/api.js` to expose your new service:

```javascript
// Add import at top
import yourprojectService from '../cleaners/yourproject_cleaning.js';

// Add endpoints before export
/**
 * POST /api/cleaning/yourproject/process
 */
router.post('/cleaning/yourproject/process', async (req, res) => {
    try {
        const { filePath, directory } = req.body;
        if (!filePath && !directory) {
            return res.status(400).json({ error: 'filePath or directory required' });
        }
        let result;
        if (directory) {
            result = await yourprojectService.processDirectory(directory);
        } else {
            result = await yourprojectService.processFile(filePath);
        }
        res.json({
            project: 'yourproject',
            result: Array.isArray(result) ? result : [result],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/yourproject/schema
 */
router.get('/cleaning/yourproject/schema', async (req, res) => {
    try {
        const schema = await yourprojectService.getSchemaInfo();
        res.json(schema);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/cleaning/yourproject/stats
 */
router.get('/cleaning/yourproject/stats', async (req, res) => {
    try {
        const stats = yourprojectService.getStatistics();
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
```

### Step 5: Restart Server

```bash
npm run dev
```

Your new project cleaner is now available!

---

## File Hierarchy

```
MigrationBot/
├── src/
│   ├── dataCleaner.js             # Generic cleaner engine
│   ├── cleaners/                  # Project-specific cleaners
│   │   ├── aetna_cleaning.js      # Aetna service
│   │   ├── cfmd_cleaning.js       # CareFirst service
│   │   ├── TEMPLATE_cleaning.js   # Template for new projects
│   │   └── yourproject_cleaning.js # Your custom project
│   └── routes/
│       └── api.js                 # Endpoints for all services
│
└── schemas/                       # Project schemas
    ├── aetna.json
    ├── carefirst.json
    └── yourproject.json
```

---

## API Endpoints by Project

### Aetna Endpoints
```
POST   /api/cleaning/aetna/process        Process Aetna files
GET    /api/cleaning/aetna/schema         Get Aetna schema
GET    /api/cleaning/aetna/stats          Get Aetna statistics
```

### CareFirst Endpoints
```
POST   /api/cleaning/carefirst/process    Process CareFirst files
GET    /api/cleaning/carefirst/schema     Get CareFirst schema
GET    /api/cleaning/carefirst/stats      Get CareFirst statistics
```

### Your Project Endpoints
```
POST   /api/cleaning/yourproject/process  Process your project files
GET    /api/cleaning/yourproject/schema   Get your project schema
GET    /api/cleaning/yourproject/stats    Get your project statistics
```

---

## Project Service Class

### Methods

All project services share these standard methods:

```javascript
// Process a single file
async processFile(filePath)
// Returns: { success, project, file, rowsProcessed, ... }

// Process a directory of files
async processDirectory(dirPath)
// Returns: Array of results

// Get schema information
async getSchemaInfo()
// Returns: { columns, requiredFields, dataQualityRules, ... }

// Get statistics
getStatistics()
// Returns: { filesProcessed, successCount, failureCount, ... }

// Reset statistics
resetStatistics()
```

### Statistics Object

Each service tracks:
```javascript
{
  project: 'aetna',
  displayName: 'Aetna',
  statistics: {
    filesProcessed: 45,
    successCount: 43,
    failureCount: 2,
    totalRowsProcessed: 12845,
    startTime: Date,
    endTime: Date
  },
  successRate: '95.56%',
  averageRowsPerFile: '298'
}
```

---

## Example: Processing Multiple Projects

**Node.js Script**:
```javascript
import aetnaService from './src/cleaners/aetna_cleaning.js';
import carefirstService from './src/cleaners/cfmd_cleaning.js';

async function processAllProjects(sourceDir) {
    console.log('Processing all project files...\n');
    
    // Aetna
    console.log('📁 Processing Aetna files...');
    const aetnaResults = await aetnaService.processDirectory(
        `${sourceDir}/aetna`
    );
    console.log(`✅ Aetna: ${aetnaResults.filter(r => r.success).length} success`);
    
    // CareFirst
    console.log('\n📁 Processing CareFirst files...');
    const cfResults = await carefirstService.processDirectory(
        `${sourceDir}/carefirst`
    );
    console.log(`✅ CareFirst: ${cfResults.filter(r => r.success).length} success`);
    
    // Print summary
    console.log('\n📊 Summary:');
    console.log('Aetna:', aetnaService.getStatistics());
    console.log('CareFirst:', carefirstService.getStatistics());
}

processAllProjects('/data/to/process');
```

**cURL Script**:
```bash
#!/bin/bash

echo "Processing Aetna files..."
curl -X POST http://localhost:3001/api/cleaning/aetna/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/data/aetna"}'

echo "Processing CareFirst files..."
curl -X POST http://localhost:3001/api/cleaning/carefirst/process \
  -H "Content-Type: application/json" \
  -d '{"directory": "/data/carefirst"}'

echo "Getting project statistics..."
curl http://localhost:3001/api/cleaning/aetna/stats | jq .
curl http://localhost:3001/api/cleaning/carefirst/stats | jq .
```

---

## Key Benefits

✅ **Project Isolation** - Each project maintains its own statistics
✅ **Independent Processing** - Process projects separately or together
✅ **Different Schemas** - Each project has unique column definitions
✅ **Easy Customization** - Add project-specific logic easily
✅ **Consistent API** - All services follow same interface
✅ **Scalable** - Add new projects without changing core code

---

## Best Practices

1. **One Cleaner Per Project** - Always create a dedicated service module
2. **Consistent Naming** - Follow naming convention: `{project}_cleaning.js`
3. **Schema First** - Always create schema before the cleaner
4. **API Endpoints** - Always expose project via REST API
5. **Statistics** - Enable monitoring for all projects
6. **Documentation** - Document any project-specific customizations

---

## Troubleshooting

### Service Not Found
```
Error: Cannot find module 'cleaners/yourproject_cleaning.js'
```
**Solution**: Verify file is in `src/cleaners/` and path in import is correct.

### Schema Not Loading
```
error: "No schema found for project yourproject"
```
**Solution**: Ensure `schemas/yourproject.json` exists and matches PROJECT_NAME constant.

### API Endpoint Returns 500
```
Error: Cannot read property 'processFile' of undefined
```
**Solution**: Check service is properly imported and exported in `api.js`.

---

## File Structure Reference

```
src/cleaners/
├── aetna_cleaning.js                    (85 lines)
├── cfmd_cleaning.js                     (85 lines)
├── TEMPLATE_cleaning.js                 (150 lines - well documented)
└── yourproject_cleaning.js              (copy of TEMPLATE)

schemas/
├── aetna.json                           (Aetna schema)
├── carefirst.json                       (CareFirst schema)
└── yourproject.json                     (Your project schema)
```

---

**Last Updated**: March 12, 2026
**Version**: 1.0.0
