// ============================================================================
// OPTIONAL LOCAL ENVIRONMENT FILE
// Node 24's built-in loader reads dotenv syntax without a runtime dependency.
// Process/deployment variables take precedence; a missing .env is normal.
// ============================================================================

export function loadOptionalEnvFile(filePath = '.env') {
  if (typeof process.loadEnvFile !== 'function') {
    throw new Error('Node.js process.loadEnvFile() is required to read .env files. Use Node 24.x.');
  }
  try {
    process.loadEnvFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
