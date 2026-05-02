.PHONY: build patch-version install clean publish

all: build

build: patch-version
	npm run compile && vsce package

patch-version:
	@echo "Patching version..."
	@python3 -c "import json; data=json.load(open('package.json')); v=data['version'].split('.'); v[2]=str(int(v[2])+1); data['version']='.'.join(v); json.dump(data, open('package.json', 'w'), indent=4)"

install: build
	@echo "Installing extension..."
	@command -v code >/dev/null 2>&1 && code --install-extension ./*.vsix --force || true
	@command -v cursor >/dev/null 2>&1 && cursor --install-extension ./*.vsix --force || true

publish: build
	vsce publish

clean:
	rm -f ./*.vsix
	rm -rf ./out
