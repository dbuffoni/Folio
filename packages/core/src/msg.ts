/** A user-visible message as an i18n key plus parameters. Services never return English sentences. */
export interface Msg {
  key: string;
  params?: Record<string, string | number>;
}
export const msg = (key: string, params?: Record<string, string | number>): Msg => (params ? { key, params } : { key });
