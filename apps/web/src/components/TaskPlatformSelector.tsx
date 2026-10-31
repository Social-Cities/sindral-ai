import type { AppPlatform } from '@sindral/shared';

interface TaskPlatformSelectorProps {
  value: readonly AppPlatform[];
  available: readonly AppPlatform[];
  onChange: (platforms: AppPlatform[]) => void;
  disabled?: boolean;
  requireOne?: boolean;
}

export function TaskPlatformSelector({ value, available, onChange, disabled, requireOne }: TaskPlatformSelectorProps) {
  return <fieldset disabled={disabled} className="space-y-2">
    <legend className="label-caps">Platforms for this task</legend>
    <div className="flex flex-wrap gap-4">
      {available.map((platform) => <label key={platform} className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={value.includes(platform)} disabled={requireOne && value.length === 1 && value.includes(platform)} onChange={() => onChange(value.includes(platform) ? value.filter((item) => item !== platform) : [...value, platform])} />
        {platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'}
      </label>)}
    </div>
    <p className="text-xs text-muted-foreground">Only selected platforms run, in iOS → Android → Web order. Selection is locked when work starts.</p>
  </fieldset>;
}
