import 'cypress-axe'; //  Correct standalone package reference
// Ignore the “Unable to establish connection” error – we are mocking the bridge
Cypress.on('uncaught:exception', (err) => {
  return !err.message.includes('Unable to establish a connection with the Custom UI bridge');

});