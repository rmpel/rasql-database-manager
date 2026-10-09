import type { RasqlApi } from '@shared/api';

declare global {
  interface Window {
    rasql: RasqlApi;
  }
}
