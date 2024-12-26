const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');
const webpack = require('webpack');

module.exports = (env, argv) => {
  const { mode } = argv;

  return {
    entry: path.join(__dirname, './src/index.ts'),
    mode: mode,
    target: 'node',
    module: {
      rules: [
        {
          test: /\.ts?$/,
          use: 'ts-loader',
          exclude: /node_modules/,
        },
      ],
    },
    resolve: {
      extensions: ['.ts', '.js','.tsx','.jsx'],
    },
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, './dist')
    },
    externals: [
      'long',
      'pino-pretty',
      'bufferutil',
      'utf-8-validate',
    ],
    optimization: {
      minimizer: [
        new TerserPlugin({ extractComments: false}),
      ],
    },
  };
}
