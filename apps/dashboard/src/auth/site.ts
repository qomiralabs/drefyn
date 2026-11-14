// What a signed out page needs to know about the server it runs on. Read on the server and
// passed down, because the forms render in the browser too.
export interface Site {
  readonly hosted: boolean;
  readonly docs: string;
}
