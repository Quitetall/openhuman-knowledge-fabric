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
