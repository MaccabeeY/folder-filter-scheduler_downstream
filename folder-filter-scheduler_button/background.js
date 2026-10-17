const MAIN_ADDON_ID = "folder-filter-scheduler@kayhan.dev.tb128.main";

browser.action.onClicked.addListener((tab, info) => {
  console.log("Toolbar button clicked! Sending remote message to main add-on...");

  // Send the cross-extension message to the main add-on
  browser.runtime.sendMessage(MAIN_ADDON_ID, { action: "RUN_ALL_RULES" })
    .then((response) => {
      if (response && response.ok) {
        console.log("Main add-on successfully processed rules. Affected:", response.affected);
      } else {
        console.error("Main add-on returned an error response:", response ? response.error : "No response");
      }
    })
    .catch((error) => {
      console.error("Could not communicate with the main add-on:", error.message);
    });
});
