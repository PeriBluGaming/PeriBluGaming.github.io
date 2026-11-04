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
  deployment: {
    // Deployed Studio https://periblugaming.sanity.studio (created by the first `sanity deploy`).
    // The app ID identifies that deployment and replaces the deprecated `studioHost`. It is not a secret:
    // access is protected by Sanity login + project membership.
    appId: 'fsi8ker3lj7cei92xxfb5lfn',
    // Serve exactly the reviewed, lock-filed Sanity version. Updates happen via package.json + review + redeploy.
    autoUpdates: false,
  },
});
