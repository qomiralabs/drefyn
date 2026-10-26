import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);

function Toggle() {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => {
        setOn(!on);
      }}
    >
      Live updates
    </button>
  );
}

// Component tests read roles, names and state from a DOM; focus, keyboard and layout run
// in real browsers instead.
describe('the component test environment', () => {
  it('runs in happy-dom', () => {
    expect(navigator.userAgent).toMatch(/HappyDOM/);
  });

  it('renders with Testing Library and drives state with user-event', async () => {
    render(<Toggle />);
    const button = screen.getByRole('button', { name: 'Live updates' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    await userEvent.setup().click(button);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });
});
