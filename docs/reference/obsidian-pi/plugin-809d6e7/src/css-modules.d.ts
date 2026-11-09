// esbuild imports .css files as text strings (loader: { '.css': 'text' }).
declare module '*.css' {
  const content: string;
  export default content;
}