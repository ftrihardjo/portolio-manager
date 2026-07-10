export const invoke = jest.fn().mockImplementation((funcKey, payload) => {
  if (funcKey === 'getProjectDetail') {
    return Promise.resolve({
      totalEstimate: '20 pts',
      remainingEstimate: '5 pts',
      velocity: '15'
    });
  }
  return Promise.resolve({});
});