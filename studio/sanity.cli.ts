import { defineCliConfig } from 'sanity/cli';
import { dataset, projectId } from './env';

/**
 * Every SANITY_STUDIO_* variable is bundled into the PUBLIC Studio JavaScript – even if no code uses it.
 * Refuse to run `sanity dev/build/deploy` if one of them looks like a credential.
 */
const leaking = Object.keys(process.env).filter(
  (name) => name.startsWith('SANITY_STUDIO_') && /TOKEN|SECRET|PASSWORD|PRIVATE|KEY|AUTH/i.test(name),
);
if (leaking.length > 0) {
  throw new Error(
    `Refusing to bundle ${leaking.join(', ')}: SANITY_STUDIO_* variables are public. ` +
      'Never give the Studio a token – it uses the logged-in user’s session.',
  );
}

export default defineCliConfig({
  api: { projectId, dataset },
  // Hostname for `npm run deploy` (free hosting on <studioHost>.sanity.studio). Change before the first deploy if taken.
  // The URL is not a secret and not a security boundary: access is protected by Sanity login + project membership.
  studioHost: 'periblugaming',
});
