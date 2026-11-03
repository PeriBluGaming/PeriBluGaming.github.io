/** Public Studio settings from studio/.env (SANITY_STUDIO_* variables are bundled by design – no secrets here). */
const projectId = process.env.SANITY_STUDIO_PROJECT_ID?.trim() ?? '';
const dataset = process.env.SANITY_STUDIO_DATASET?.trim() || 'production';

if (!/^[a-z0-9]+$/.test(projectId)) {
  throw new Error(
    'SANITY_STUDIO_PROJECT_ID is missing or invalid. Copy studio/.env.example to studio/.env and set it ' +
      '(see docs/sanity-setup.md).',
  );
}

export { dataset, projectId };
