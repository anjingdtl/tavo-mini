import { valueFromTrackPosition } from '../src/components/ConstructionSlider';

describe('construction slider coordinate mapping', () => {
  it('does not derive a value before the track has been measured', () => {
    expect(
      valueFromTrackPosition(300, { x: 0, width: 0 }, 1, 15),
    ).toBeNull();
  });

  it('maps measured absolute coordinates into discrete slider values', () => {
    expect(
      valueFromTrackPosition(200, { x: 100, width: 200 }, 1, 15),
    ).toBe(8);
    expect(
      valueFromTrackPosition(1000, { x: 100, width: 200 }, 1, 15),
    ).toBe(15);
  });
});
