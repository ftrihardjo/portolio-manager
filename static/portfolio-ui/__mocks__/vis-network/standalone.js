// jsdom has no canvas support, so vis-network can't actually render during
// tests. This stand-in lets components that use it mount without throwing.
export const Network = jest.fn().mockImplementation(() => ({
  on: jest.fn(),
  destroy: jest.fn(),
}));

export const DataSet = jest.fn().mockImplementation((items) => items || []);