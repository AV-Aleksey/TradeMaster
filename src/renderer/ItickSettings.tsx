import type { Command } from '../shared/model';
import { ProviderSettings } from './ProviderSettings';

export function ItickSettings({ configured, invoke }: { configured: boolean; invoke: (command: Command) => Promise<unknown> }): React.JSX.Element {
  return <ProviderSettings providerId="itick" name="iTick" configured={configured} invoke={invoke}
    environments={[{ value: 'itick-trial', label: 'Trial' }, { value: 'itick', label: 'Production' }]} />;
}
