#!/bin/bash

# Navigate to the project root directory relative to this script
cd "$(dirname "$0")/../.." || exit 1

# Define archive output names (placed at project root)
BUTTON_XPI="folder-filter-scheduler_button.xpi"
MAIN_XPI="folder-filter-scheduler_main.xpi"

# Define the directory of the button addon
BUTTON_DIR="folder-filter-scheduler_button"

# Define the path to the 7-Zip executable
ZIP="C:\Program Files\7-Zip\7z.exe"

# Check the input parameter (converted to lowercase)
TARGET=$(echo "$1" | tr '[:upper:]' '[:lower:]')

# Function to build the button addon using 7-Zip
build_button() {
    if [ -d "$BUTTON_DIR" ]; then
        echo "📦 Building Button Add-on ($BUTTON_XPI) with 7-Zip..."
        rm -f "$BUTTON_XPI"
        
        # Move into the folder so the zip archive root is flat
        cd "$BUTTON_DIR" || exit 1
        
        # FIXED TWEAK: Added explicit exclusions to keep the button's internal structure clean
        "$ZIP" a -tzip "../$BUTTON_XPI" * \
            -xr!"*.git*" \
            -xr!"*node_modules*" \
            -xr!"scripts" \
            -xr!"docs" \
            -xr!"test" > /dev/null
            
        cd .. || exit 1
        
        echo "✅ Button Add-on created successfully!"
    else
        echo "❌ Error: Button folder '$BUTTON_DIR' not found."
        exit 1
    fi
}

# Function to build the main addon using 7-Zip
build_main() {
    echo "📦 Building Main Add-on ($MAIN_XPI) with 7-Zip..."
    rm -f "$MAIN_XPI"
    
    # Maps the list path directly into your nested button scripts folder
    LIST_FILE="folder-filter-scheduler_button/scripts/include_list.txt"

    # CRITICAL TWEAK: The whitelist block now ONLY allows manifest.json at the root level!
    cat << 'EOF' > "$LIST_FILE"
manifest.json
EOF

    # Grab only standard, visible project subfolders.
    # The '! -name ".*"' condition guarantees that hidden directories like .git or .vscode are entirely locked out.
    find . -maxdepth 1 -type d ! -name "." ! -name ".*" | sed 's|^\./||' | awk '{print $0 "/*"}' >> "$LIST_FILE"

    # Execute 7-Zip using the tightly locked inclusion file list
    "$ZIP" a -tzip "$MAIN_XPI" -i@"${LIST_FILE}" \
        -xr!"$BUTTON_DIR" \
        -xr!"$BUTTON_XPI" \
        -xr!"$MAIN_XPI" \
        -xr!"scripts" \
        -xr!"docs" \
        -xr!"test" > /dev/null

    # Clean up the temporary list file
    rm -f "$LIST_FILE"

    echo "✅ Main Add-on created successfully!"
}

echo "=========================================="
echo " Thunderbird Add-on Build Script (7-Zip)"
echo "=========================================="

# Ensure 7-Zip is accessible
if [ ! -f "$ZIP" ]; then
    echo "❌ Error: 7-Zip executable not found at: $ZIP"
    echo "Please verify your 7-Zip installation path."
    exit 1
fi

# Route the build process based on parameter
case "$TARGET" in
    "button")
        build_button
        ;;
    "main")
        build_main
        ;;
    "")
        echo "🧹 Cleaning previous builds..."
        rm -f "$BUTTON_XPI" "$MAIN_XPI"
        build_button
        echo "------------------------------------------"
        build_main
        ;;
    *)
        echo "❌ Error: Invalid parameter '$1'"
        echo "Usage:"
        echo "  ./folder-filter-scheduler_button/scripts/buildxpi.sh          -> Builds BOTH add-ons"
        echo "  ./folder-filter-scheduler_button/scripts/buildxpi.sh button   -> Builds ONLY the toolbar button add-on"
        echo "  ./folder-filter-scheduler_button/scripts/buildxpi.sh main     -> Builds ONLY the main scheduler add-on"
        exit 1
        ;;
esac

echo "=========================================="
echo "🎉 Done! Files saved to project root."
