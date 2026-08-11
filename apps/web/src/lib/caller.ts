/**
 * Who the web application is acting as.
 *
 * A stand-in until Keycloak lands in Gate 8, and one that refuses to be anything else: it
 * reads a fixed identity from the environment and throws outside development. A web app that
 * silently fell back to a default identity in production would attribute every action to
 * whoever set the variable last, which is worse than not working.
 */

import type { Caller } from './api';

export function developmentCaller(): Caller {
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
    actorId: required('KF_DEV_ACTOR'),
    actingRoleId: required('KF_DEV_ACTING_ROLE'),
    organizationId: required('KF_DEV_ORGANIZATION'),
    maxClassification: process.env['KF_DEV_CLASSIFICATION'] ?? 'internal',
  };
}
