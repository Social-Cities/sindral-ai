import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeProvider';

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

describe('ThemeProvider', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.cookie = 'sindral_theme=; path=/; max-age=0';
    document.documentElement.dataset.theme = 'dark';
  });

  it('applies and persists the selected theme', async () => {
    window.localStorage.clear();
    document.documentElement.dataset.theme = 'dark';

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'dark' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'dark' }));

    expect(screen.getByRole('button', { name: 'light' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('sindral-theme')).toBe('light');
    expect(document.cookie).toContain('sindral_theme=light');
  });

  it('falls back to the persisted cookie when local storage is empty', () => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.cookie = 'sindral_theme=light; path=/';

    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'light' })).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
