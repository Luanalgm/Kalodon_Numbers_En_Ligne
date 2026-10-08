<?php
// Déclenche la mise à jour Git automatique sur Alwaysdata
exec('git pull origin main 2>&1', $output);
echo implode("\n", $output);
?>