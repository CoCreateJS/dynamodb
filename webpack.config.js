/********************************************************************************
 * Copyright (C) 2026 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

import webpack from "webpack";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EsbuildPlugin } from "esbuild-loader";
import { FileUploader } from "@cocreate/webpack";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async (env, argv) => {
    const isProduction = argv && argv.mode === "production";

    const config = {
        // Target Node.js environment for Worker Threads execution
        target: "node",

        // Output native ES Module bundle syntax
        experiments: {
            outputModule: true
        },

        // Entry point for the DynamoDB database adapter
        entry: {
            "dynamodb": "./src/index.js"
        },

        output: {
            path: path.resolve(__dirname, "dist"),
            // Produces 'dynamodb.bundle.js'
            filename: "[name].bundle.js",
            library: {
                type: "module"
            },
            clean: true,
            // Retain standard global scope in worker threads
            globalObject: "this"
        },

        resolve: {
            extensions: [".js", ".mjs", ".cjs", ".json", ".ts"],
            fullySpecified: false
        },

        node: {
            __dirname: false,
            __filename: false
        },

        plugins: [
            // Enforce single-file bundle output without dynamic split chunks
            new webpack.optimize.LimitChunkCountPlugin({
                maxChunks: 1
            }),

            // Ignore optional native CRT bindings, non-essential credential providers, and docs
            new webpack.IgnorePlugin({
                resourceRegExp: /^(aws-crt|@aws-sdk\/signature-v4-crt|@aws-sdk\/credential-providers|cardinal|\.d\.ts)$/
            }),

            // Uploads bundled driver script to CDN/HTTP endpoint if configured
            new FileUploader(env, argv)
        ],

        // Disable source map generation completely to eliminate .map files and minimize output size
        devtool: false,
        mode: isProduction ? "production" : "development",

        module: {
            rules: [
                {
                    // Relax strict ESM extension requirements for node_modules resolution
                    test: /\.m?[jc]s$/,
                    type: "javascript/auto",
                    resolve: {
                        fullySpecified: false
                    }
                },
                {
                    test: /\.js$/,
                    exclude: /node_modules/,
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "js",
                            target: "node18"
                        }
                    }
                },
                {
                    test: /\.ts$/,
                    exclude: [/node_modules/, /\.d\.ts$/],
                    use: {
                        loader: "esbuild-loader",
                        options: {
                            loader: "ts",
                            target: "node18"
                        }
                    }
                }
            ]
        },

        optimization: {
            minimize: isProduction,
            minimizer: [
                new EsbuildPlugin({
                    target: "node18"
                })
            ],
            // Enforce single-file output by disabling chunk splitting
            splitChunks: false,
            runtimeChunk: false
        },

        performance: {
            hints: false
        }
    };

    return config;
};