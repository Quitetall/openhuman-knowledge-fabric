/**
 * Who the web application is acting as.
 *
 * A deliberately non-authoritative stand-in for the `development` deployment profile.
 *
 * Shared dogfood uses the separate OIDC web-session path. This helper refuses dogfood outright;
 * it never turns a fixed environment value into an apparently authenticated person. A web app
 * that silently fell back to a default identity would attribute every action to whoever set the
 * variable last, which is worse than not working.
 */

import type { Caller } from './api';

export function developmentCaller(): Caller {
  const profile = process.env['KF_DEPLOYMENT_PROFILE'];
  if (profile === undefined || profile === '') {
    throw new Error(
      'KF_DEPLOYMENT_PROFILE is required; set it explicitly to development or dogfood.',
    );
  }
  if (profile !== 'development' && profile !== 'dogfood') {
    throw new Error(
      `KF_DEPLOYMENT_PROFILE must be development or dogfood, got ${JSON.stringify(profile)}.`,
    );
  }
  if (profile === 'dogfood') {
    throw new Error(
      'The dogfood profile requires a real bearer-authenticated identity. The fixed ' +
        'development caller is disabled; configure the web OIDC session and bearer-token ' +
        'forwarding before serving this interface.',
    );
  }

  const environment = process.env['NODE_ENV'] ?? 'development';
  if (environment !== 'development' && environment !== 'test') {
    throw new Error(
      'No identity provider is configured. The web application refuses to act as a ' +
        'fixed identity outside development — every action would be attributed to the ' +
        'wrong person.',
    );
  }
  // A SECOND, explicit signal. NODE_ENV is set by whoever starts the process and then gets
  // inherited, copied and defaulted in ways nobody tracks — on its own it records a habit,
  // not a decision. Acting as a fixed identity should be something an operator turned on
  // meaning to, and this is the variable that has no other purpose.
  if (process.env['KF_ALLOW_FIXED_IDENTITY'] !== '1') {
    throw new Error(
      'Acting as a fixed development identity requires KF_ALLOW_FIXED_IDENTITY=1. Set it ' +
        'deliberately, and never in a deployment whose records anyone relies on.',
    );
  }
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} is required to run the web application in development`);
    }
    return value;
  };
  return {
    authentication: 'development',
    actorId: required('KF_DEV_ACTOR'),
    actingRoleId: required('KF_DEV_ACTING_ROLE'),
    organizationId: required('KF_DEV_ORGANIZATION'),
    maxClassification: process.env['KF_DEV_CLASSIFICATION'] ?? 'internal',
  };
}
