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

export const router = {
  open: jest.fn().mockResolvedValue(undefined),
  navigate: jest.fn().mockResolvedValue(undefined),
  getUrl: jest.fn().mockResolvedValue(new URL('https://example.atlassian.net/')),
  reload: jest.fn(),
};