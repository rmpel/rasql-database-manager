#!/usr/bin/env bash

cd "$(dirname "$0")"

[ -d $HOME/Applications/RaSQL.app ] && rm -rf $HOME/Applications/RaSQL.app || true

cp -a ./packages/app/release/mac-arm64/RaSQL.app $HOME/Applications/

