import appManifest from '../app.manifest.json';

const REQUIRED_METADATA_FIELDS = ['id', 'name', 'version', 'shortDescription', 'aiDescription', 'github', 'releaseApiUrl'];

export function validateAppMetadata(metadata = appManifest) {
  if (!import.meta.env.DEV) {
    return metadata;
  }

  const missingFields = REQUIRED_METADATA_FIELDS.filter((fieldName) => {
    const value = metadata[fieldName];
    return typeof value !== 'string' || value.trim() === '';
  });

  if (missingFields.length > 0) {
    console.warn(`[app.manifest] Missing required metadata fields: ${missingFields.join(', ')}`);
  }

  return metadata;
}

export default appManifest;
