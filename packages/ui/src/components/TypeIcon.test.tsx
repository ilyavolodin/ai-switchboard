import { ICON_NAMES } from '@ai-switchboard/sdk/icons';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TypeIcon } from './TypeIcon.js';

const svg = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`;

describe('TypeIcon', () => {
  it('draws a declared built-in icon', () => {
    const { container } = render(<TypeIcon icon="webhook" kind="source" />);
    const generic = render(<TypeIcon icon={null} kind="source" />).container;
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.innerHTML).not.toBe(generic.innerHTML);
  });

  it('renders an SVG data URI through <img>, never inline', () => {
    const { container } = render(<TypeIcon icon={svg} kind="destination" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', svg);
    expect(img).toHaveAttribute('alt', '');
    expect(container.querySelector('svg')).toBeNull();
  });

  it.each([
    ['an unknown name', 'rocket'],
    ['a non-SVG data URI', 'data:text/html;base64,PHNjcmlwdD4='],
    ['an SVG URI whose payload is not SVG', `data:image/svg+xml;base64,${btoa('<b>x</b>')}`],
    ['nothing', undefined],
  ])('falls back to the generic icon for %s', (_label, icon) => {
    const { container } = render(<TypeIcon icon={icon} kind="destination" />);
    const generic = render(<TypeIcon icon="destinations" kind="destination" />).container;
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toBe(generic.innerHTML);
  });

  it('has a drawing for every SDK icon name', () => {
    for (const name of ICON_NAMES) {
      const { container } = render(<TypeIcon icon={name} kind="source" />);
      expect(container.querySelector('svg')?.childElementCount).toBeGreaterThan(0);
    }
  });
});
