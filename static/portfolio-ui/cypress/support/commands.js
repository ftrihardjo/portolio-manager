// cypress/support/commands.js
Cypress.Commands.add('switchTab', (tabName) => {
  cy.contains('button', tabName).click();
  cy.contains('button', tabName).should('have.class', 'active');
});

Cypress.Commands.add('mockForgeBridge', (overrides, scenario) => {
  cy.visit('/', {
    onBeforeLoad(win) {
      win.__bridge = advancedForgeBridgeMock(overrides, scenario);
    },
  });
});

Cypress.Commands.add('waitForDataLoad', (timeout = 5000) => {
  cy.get('[data-testid="loading-spinner"]', { timeout }).should('not.exist');
});