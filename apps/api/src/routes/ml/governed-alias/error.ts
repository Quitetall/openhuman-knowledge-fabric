export class GovernedAliasUnverifiable extends Error {
  constructor() {
    super('governed alias verification material is unavailable');
    this.name = 'GovernedAliasUnverifiable';
  }
}
