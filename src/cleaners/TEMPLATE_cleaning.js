/**
 * Project Data Cleaning Module Template
 * ══════════════════════════════════════════════════════════════════
 *
 * Template for creating specialized cleaning handlers for new projects.
 * Copy this file and customise for your project:
 *
 * 1. Replace PROJECT_NAME and PROJECT_DISPLAY_NAME.
 * 2. Add targetTable fields to schemas/{PROJECT_NAME}.json for each column
 *    (see schemas/aetna_tables_example.json for reference).
 * 3. Customise processFile() with project-specific pre/post logic if needed.
 * 4. Add project-specific validation methods at the bottom.
 * 5. Register the new service in src/routes/api.js.
 *
 * Output modes
 * ────────────
 * • outputMode = 'excel'  (default) — existing behaviour; produces .xlsx/.csv
 *   uploaded to Azure Blob Storage.
 * • outputMode = 'json'   — groups cleaned columns by their schema targetTable,
 *   serialises as JSON, and uploads as {filename}_cleaned.json to Blob Storage.
 *   The grouped JSON is also returned in result.tableGroups for direct API use.
 *
 * The mode is resolved in this priority order:
 *   per-call options.outputMode  >  CLEANING_OUTPUT_MODE env var  >  'excel'
 *
 * Usage
 * ──────
 * import myProjectService from './my_project_cleaning.js';
 *
 * // Process single file (Excel output, default)
 * const result = await myProjectService.processFile('path/to/file.xlsx');
 *
 * // Process single file (JSON output)
 * const result = await myProjectService.processFile('path/to/file.xlsx', { outputMode: 'json' });
 * // result.tableGroups → { tableName: [ { camelCaseCol: value, … }, … ], … }
 *
 * // Process directory
 * const results = await myProjectService.processDirectory('path/to/dir', { outputMode: 'json' });
 *
 * // Get schema info
 * const schema = await myProjectService.getSchemaInfo();
 *
 * // Get statistics
 * const stats = myProjectService.getStatistics();
 */

import dataCleaner from '../dataCleaner.js';
import path from 'path';
import fs from 'fs';

// !! CUSTOMISE THESE FOR YOUR PROJECT !!
const PROJECT_NAME = 'myproject';              // Matches schema filename: schemas/myproject.json
const PROJECT_DISPLAY_NAME = 'My Project';    // Display name for logging

class MyProjectCleaningService {
    constructor() {
        this.projectName = PROJECT_NAME;
        this.displayName = PROJECT_DISPLAY_NAME;
        this.statistics = {
            filesProcessed: 0,
            successCount: 0,
            failureCount: 0,
            totalRowsProcessed: 0,
            startTime: null,
            endTime: null
        };
    }

    /**
     * Process a single file for this project.
     *
     * @param {string} filePath             - Path to input file (XLSX or CSV)
     * @param {Object} [options={}]         - Processing options
     * @param {string} [options.outputMode] - 'excel' (default) or 'json'
     * @returns {Promise<Object>} Processing result with status and metadata
     */
    async processFile(filePath, options = {}) {
        console.log(`\n📋 ${this.displayName.toUpperCase()}: Processing ${path.basename(filePath)}`);

        this.statistics.startTime = new Date();
        this.statistics.filesProcessed++;

        // Resolve output mode: per-call option > env var > default
        const outputMode = options.outputMode || process.env.CLEANING_OUTPUT_MODE || 'excel';

        try {
            // Step 1: Validate file exists
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }

            // Step 2: Optional — add project-specific pre-processing here
            // Example: check file naming convention, validate format, etc.

            // Step 3: Process file through main DataCleaner.
            // The DataCleaner will:
            //   - Load your project schema (schemas/{PROJECT_NAME}.json)
            //   - Validate columns against schema and convert data types
            //   - Apply quality rules
            //   - When outputMode='json': call groupByTable() and upload as .json
            //   - When outputMode='excel': convert and upload as .xlsx/.csv
            //   - Store processing metadata in SQL
            const result = await dataCleaner.processFile(filePath, this.projectName, { outputMode });

            if (result.success) {
                this.statistics.successCount++;
                this.statistics.totalRowsProcessed += result.metadata?.rowCount || 0;

                console.log(`✅ ${this.displayName}: Successfully processed ${result.metadata?.rowCount || 0} rows`);
                console.log(`📁 Uploaded: ${result.metadata?.blobPath}`);

                // Step 4: Optional — add project-specific post-processing here
                // Example: update status, trigger downstream processes, etc.

                return {
                    success: true,
                    project: this.projectName,
                    file: path.basename(filePath),
                    outputMode,
                    rowsProcessed: result.metadata?.rowCount || 0,
                    uploadedTo: result.metadata?.blobPath,
                    // tableGroups is populated when outputMode='json'; null otherwise
                    tableGroups: result.groupedData || null,
                    processingTime: new Date() - this.statistics.startTime
                };
            } else {
                this.statistics.failureCount++;
                console.error(`❌ ${this.displayName}: Processing failed - ${result.error}`);

                return {
                    success: false,
                    project: this.projectName,
                    file: path.basename(filePath),
                    outputMode,
                    error: result.error,
                    processingTime: new Date() - this.statistics.startTime
                };
            }
        } catch (error) {
            this.statistics.failureCount++;
            console.error(`❌ ${this.displayName}: Error processing file:`, error.message);

            return {
                success: false,
                project: this.projectName,
                file: path.basename(filePath),
                outputMode,
                error: error.message,
                processingTime: new Date() - this.statistics.startTime
            };
        }
    }

    /**
     * Process multiple files from a directory.
     *
     * @param {string} dirPath              - Directory containing files to process
     * @param {Object} [options={}]         - Options forwarded to processFile
     * @param {string} [options.outputMode] - 'excel' (default) or 'json'
     * @returns {Promise<Array>} Array of processing results
     */
    async processDirectory(dirPath, options = {}) {
        console.log(`\n🔄 ${this.displayName.toUpperCase()}: Processing directory: ${dirPath}`);

        if (!fs.existsSync(dirPath)) {
            console.error(`Directory not found: ${dirPath}`);
            return [];
        }

        const results = [];
        const files = fs.readdirSync(dirPath)
            .filter(f => /\.(xlsx|xls|csv)$/i.test(f))
            .map(f => path.join(dirPath, f));

        console.log(`Found ${files.length} files to process`);

        for (const file of files) {
            const result = await this.processFile(file, options);
            results.push(result);
        }

        this.statistics.endTime = new Date();
        console.log(`\n📊 ${this.displayName}: Completed ${files.length} files`);

        return results;
    }

    /**
     * Get project schema information.
     * @returns {Promise<Object>} Schema details
     */
    async getSchemaInfo() {
        try {
            const schema = await dataCleaner.getProjectSchema(this.projectName);
            return {
                project: this.projectName,
                displayName: this.displayName,
                columns: Object.keys(schema?.columns || {}).length,
                requiredFields: schema?.requiredFields || [],
                dataQualityRules: schema?.dataQualityRules || [],
                schema: schema
            };
        } catch (error) {
            console.error('Failed to get schema info:', error.message);
            return { error: error.message };
        }
    }

    /**
     * Get cleaning statistics for this project.
     * @returns {Object} Project-specific statistics
     */
    getStatistics() {
        return {
            project: this.projectName,
            displayName: this.displayName,
            statistics: this.statistics,
            successRate: this.statistics.filesProcessed > 0
                ? (this.statistics.successCount / this.statistics.filesProcessed * 100).toFixed(2) + '%'
                : 'N/A',
            averageRowsPerFile: this.statistics.filesProcessed > 0
                ? (this.statistics.totalRowsProcessed / this.statistics.successCount).toFixed(0)
                : 0
        };
    }

    /**
     * Reset statistics.
     */
    resetStatistics() {
        this.statistics = {
            filesProcessed: 0,
            successCount: 0,
            failureCount: 0,
            totalRowsProcessed: 0,
            startTime: null,
            endTime: null
        };
    }

    // ════════════════════════════════════════════════════════════════
    // Optional: Add project-specific methods below
    // ════════════════════════════════════════════════════════════════

    /**
     * Example: Project-specific validation
     */
    async validateProjectSpecific(data) {
        // Add custom validation logic here
        // Return { valid: true/false, errors: [...] }
    }

    /**
     * Example: Project-specific transformation
     */
    async transformData(data) {
        // Add custom transformation logic here
        // Return transformed data
    }
}

// Export singleton instance
export const myProjectService = new MyProjectCleaningService();
export default myProjectService;
