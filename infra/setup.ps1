<#
  Opsætning af den samlede booking-backend.

  Opretter:
    1. Multi-tenant app-registrering i TimeWinder-tenanten med app-permissions til Graph:
         Bookings.Read.All, BookingsAppointment.ReadWrite.All, Calendars.ReadBasic
       + admin-consent i TimeWinder. Consent i haulund-aadorf.dk sker via et link (åbnes i browseren).
    2. Azure Function App (Flex Consumption, Node) i TimeWinder-abonnementet med app settings og CORS.
    3. Deploy af ./api.

  Kør fra repo-roden:  ./infra/setup.ps1 -MailboxHaulund thomas@... -MailboxTimewinder thha@...
  Kan køres igen: eksisterende ressourcer genbruges, og hemmeligheden fornyes kun med -RotateSecret.

  Bemærk: Calendars.ReadBasic som app-permission gælder alle postkasser i tenanten.
  Begræns den til din egen postkasse med Exchange "RBAC for Applications" (se slutningen af scriptet).
#>
param(
  [Parameter(Mandatory)][string]$MailboxHaulund,
  [Parameter(Mandatory)][string]$MailboxTimewinder,
  [string]$AtpIcsUrl = '',
  [string]$AppName = 'haulund-booking',
  [string]$ResourceGroup = 'rg-haulund-booking',
  [string]$Location = 'swedencentral',
  [string]$Subscription = 'Timewinder',
  [string]$SiteOrigin = 'https://haulund-atp.h-aa.dk',
  [switch]$RotateSecret
)
$ErrorActionPreference = 'Stop'
$TenantTimewinder = '67a0d407-4ca4-4ee5-bf31-c3bbe3e0120e'
$TenantHaulund = 'dbfb3e09-8afe-4c61-8ece-9ed3b5e940bd'
$GraphAppId = '00000003-0000-0000-c000-000000000000'
$Permissions = 'Bookings.Read.All', 'BookingsAppointment.ReadWrite.All', 'Calendars.ReadBasic.All'

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

az account set --subscription $Subscription
if ((az account show --query tenantId -o tsv) -ne $TenantTimewinder) { throw "Abonnementet '$Subscription' ligger ikke i TimeWinder-tenanten" }

# ---------- 1. app-registrering ----------
Step 'App-registrering'
$appId = az ad app list --display-name $AppName --query '[0].appId' -o tsv
if (-not $appId) {
  $appId = az ad app create --display-name $AppName --sign-in-audience AzureADMultipleOrgs --query appId -o tsv
  Write-Host "Oprettet $appId"
} else { Write-Host "Findes allerede: $appId" }
# Uden en reply-adresse ender admin-consent-linket i AADSTS500113 (consent gives, men redirect fejler).
az ad app update --id $appId --web-redirect-uris "$SiteOrigin/Booking/" -o none

$roles = az ad sp show --id $GraphAppId --query 'appRoles[].{id:id, value:value}' -o json | ConvertFrom-Json
$access = foreach ($p in $Permissions) {
  $r = $roles | Where-Object value -eq $p
  if (-not $r) { throw "Fandt ikke Graph-rollen $p" }
  "$($r.id)=Role"
}
az ad app permission add --id $appId --api $GraphAppId --api-permissions $access 2>$null | Out-Null

if (-not (az ad sp list --filter "appId eq '$appId'" --query '[0].id' -o tsv)) { az ad sp create --id $appId | Out-Null }
Step 'Admin-consent i TimeWinder'
# 'az ad app permission admin-consent' tildeler ikke app-roller pålideligt, så de tildeles direkte.
$spId = az ad sp list --filter "appId eq '$appId'" --query '[0].id' -o tsv
$graphSpId = az ad sp show --id $GraphAppId --query id -o tsv
$assigned = az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignments" -o json |
  ConvertFrom-Json | ForEach-Object { $_.value.appRoleId }
foreach ($p in $Permissions) {
  $roleId = ($roles | Where-Object value -eq $p).id
  if ($assigned -contains $roleId) { continue }
  $tmp = New-TemporaryFile
  @{ principalId = $spId; resourceId = $graphSpId; appRoleId = $roleId } | ConvertTo-Json | Set-Content $tmp
  az rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/$spId/appRoleAssignments" `
    --headers 'Content-Type=application/json' --body "@$tmp" -o none
  Remove-Item $tmp
  Write-Host "Tildelt $p"
}

# ---------- 2. Function App ----------
Step 'Function App'
az group create -n $ResourceGroup -l $Location -o none
$storage = ('st' + ($AppName -replace '[^a-z0-9]', '')).Substring(0, [Math]::Min(24, 2 + ($AppName -replace '[^a-z0-9]', '').Length))
if (-not (az storage account show -n $storage -g $ResourceGroup --query id -o tsv 2>$null)) {
  az storage account create -n $storage -g $ResourceGroup -l $Location --sku Standard_LRS --allow-blob-public-access false -o none
}
if (-not (az functionapp show -n $AppName -g $ResourceGroup --query id -o tsv 2>$null)) {
  az functionapp create -n $AppName -g $ResourceGroup --storage-account $storage `
    --flexconsumption-location $Location --runtime node --runtime-version 22 -o none
}

$settings = @(
  "BOOKING_CLIENT_ID=$appId",
  "MAILBOX_HAULUND=$MailboxHaulund",
  "MAILBOX_TIMEWINDER=$MailboxTimewinder",
  "BOOKING_TIMEZONE=Europe/Copenhagen"
)
if ($AtpIcsUrl) { $settings += "ATP_ICS_URL=$AtpIcsUrl" }

$hasSecret = az functionapp config appsettings list -n $AppName -g $ResourceGroup --query "[?name=='BOOKING_CLIENT_SECRET'] | length(@)" -o tsv
if ($RotateSecret -or $hasSecret -eq '0') {
  Step 'Ny client secret (1 år)'
  $secret = az ad app credential reset --id $appId --display-name 'booking-api' --years 1 --append --query password -o tsv
  $settings += "BOOKING_CLIENT_SECRET=$secret"
}
az functionapp config appsettings set -n $AppName -g $ResourceGroup --settings $settings -o none

az functionapp cors add -n $AppName -g $ResourceGroup --allowed-origins $SiteOrigin -o none 2>$null

# ---------- 3. deploy ----------
Step 'Deploy af api/'
$apiDir = Join-Path $PSScriptRoot '..\api'
$stage = Join-Path ([IO.Path]::GetTempPath()) "$AppName-deploy"
$zip = "$stage.zip"
Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item (Join-Path $apiDir 'host.json'), (Join-Path $apiDir 'package.json'), (Join-Path $apiDir 'package-lock.json') $stage
Copy-Item (Join-Path $apiDir 'src') $stage -Recurse
Push-Location $stage
try { npm ci --omit=dev --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci fejlede' } } finally { Pop-Location }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
az functionapp deployment source config-zip -n $AppName -g $ResourceGroup --src $zip -o none
if ($LASTEXITCODE) { throw 'Deploy fejlede' }
Remove-Item $stage, $zip -Recurse -Force -ErrorAction SilentlyContinue

# ---------- consent i haulund-aadorf.dk ----------
Step 'Admin-consent i haulund-aadorf.dk'
$consentUrl = "https://login.microsoftonline.com/$TenantHaulund/adminconsent?client_id=$appId&redirect_uri=$([uri]::EscapeDataString("$SiteOrigin/Booking/"))"
Write-Host "Log ind som admin i haulund-aadorf.dk og godkend: $consentUrl"
Start-Process $consentUrl

Write-Host @"

Færdig. Test:  https://$AppName.azurewebsites.net/api/catalog

Anbefalet bagefter (begræns kalenderadgangen til din egen postkasse) i hver tenant:
  Connect-ExchangeOnline -Organization <tenant>
  New-ManagementScope -Name 'BookingMailbox' -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<postkasse>'"
  New-ServicePrincipal -AppId $appId -ObjectId <enterprise app object id> -DisplayName $AppName
  New-ManagementRoleAssignment -App $appId -Role 'Application Calendars.Read' -CustomResourceScope 'BookingMailbox'
  ... og fjern derefter Calendars.ReadBasic fra app-registreringen.
"@ -ForegroundColor Green
