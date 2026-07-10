// cypress/support/factories/portfolioFactory.js
export const PortfolioFactory = {
  createProject(overrides = {}) {
    return {
      id: faker.datatype.number(),
      key: `PROJ-${faker.random.alphaNumeric(4).toUpperCase()}`,
      name: faker.company.companyName(),
      lead: faker.name.fullName(),
      ...overrides
    };
  },

  createDependencyChain(length = 3) {
    return Array.from({ length }, (_, i) => ({
      id: `P${i + 1}-1`,
      title: `Task Level ${i + 1}`,
      links: i < length - 1 ? [{ type: 'Blocks', inward: `P${i + 2}-1` }] : []
    }));
  }
};